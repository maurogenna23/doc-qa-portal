import type { IngestDocumentInput } from '@docqa/contracts';
import { chunkId, chunkText, DEFAULT_CHUNKING_OPTIONS, type ChunkingOptions } from './chunking.js';
import { UpstreamError } from './errors.js';
import {
  silentLogger,
  type EmbeddingProvider,
  type Logger,
  type TokenUsage,
  type VectorRecord,
  type VectorStore,
} from './ports.js';

export interface IngestDeps {
  embeddings: EmbeddingProvider;
  store: VectorStore;
  logger?: Logger;
  chunking?: ChunkingOptions;
  embeddingBatchSize?: number;
  upsertBatchSize?: number;
}

export interface IngestResult {
  ingestedDocuments: number;
  ingestedChunks: number;
}

/** One HTTP round trip per batch instead of one per chunk. */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 96;
/** Keeps a single upsert payload well under typical vector-store request limits. */
export const DEFAULT_UPSERT_BATCH_SIZE = 100;

function batch<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function addUsage(total: TokenUsage, next: TokenUsage | undefined): TokenUsage {
  if (next === undefined) return total;
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  };
}

/** Embeds every text, batching the calls and verifying the provider honoured the contract. */
async function embedAll(
  embeddings: EmbeddingProvider,
  texts: readonly string[],
  batchSize: number,
): Promise<{ vectors: number[][]; usage: TokenUsage }> {
  const vectors: number[][] = [];
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const group of batch(texts, batchSize)) {
    const result = await embeddings.embed(group);

    if (result.vectors.length !== group.length) {
      throw new UpstreamError(
        'EMBEDDING_PROVIDER_ERROR',
        `Embedding provider returned ${result.vectors.length} vectors for ${group.length} inputs.`,
      );
    }
    for (const vector of result.vectors) {
      if (vector.length !== embeddings.dimensions) {
        throw new UpstreamError(
          'EMBEDDING_PROVIDER_ERROR',
          `Embedding provider returned a ${vector.length}-dimension vector, expected ${embeddings.dimensions}. ` +
            'Check that EMBEDDING_MODEL matches the dimension of the Pinecone index.',
        );
      }
    }

    vectors.push(...result.vectors);
    usage = addUsage(usage, result.usage);
  }

  return { vectors, usage };
}

/**
 * Chunks, embeds and stores documents.
 *
 * Re-ingesting a document id replaces it rather than duplicating it. The
 * sequence per document is deliberate:
 *
 *   1. list the ids the store currently holds for this document
 *   2. upsert the new chunks (stable ids, so shared positions overwrite in place)
 *   3. delete the ids that survived from the previous version but are no longer produced
 *
 * Upserting before deleting means the document is never momentarily missing
 * from the index. Deleting first would open a window where a concurrent /ask
 * could retrieve nothing.
 */
export async function ingestDocuments(
  deps: IngestDeps,
  documents: readonly IngestDocumentInput[],
): Promise<IngestResult> {
  const {
    embeddings,
    store,
    logger = silentLogger,
    chunking = DEFAULT_CHUNKING_OPTIONS,
    embeddingBatchSize = DEFAULT_EMBEDDING_BATCH_SIZE,
    upsertBatchSize = DEFAULT_UPSERT_BATCH_SIZE,
  } = deps;

  let ingestedDocuments = 0;
  let ingestedChunks = 0;
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const document of documents) {
    const chunks = chunkText(document.content, chunking);
    if (chunks.length === 0) {
      logger.warn('Document produced no chunks; skipping.', { docId: document.id });
      continue;
    }

    const { vectors, usage } = await embedAll(
      embeddings,
      chunks.map((chunk) => chunk.text),
      embeddingBatchSize,
    );
    totalUsage = addUsage(totalUsage, usage);

    const records: VectorRecord[] = [];
    for (const [position, chunk] of chunks.entries()) {
      const values = vectors[position];
      if (values === undefined) {
        throw new UpstreamError(
          'EMBEDDING_PROVIDER_ERROR',
          `Missing embedding for chunk ${position} of document "${document.id}".`,
        );
      }
      records.push({
        id: chunkId(document.id, chunk.index),
        values,
        metadata: {
          docId: document.id,
          title: document.title,
          chunkText: chunk.text,
          chunkIndex: chunk.index,
        },
      });
    }

    const previousIds = await store.listIdsByDocId(document.id);

    for (const group of batch(records, upsertBatchSize)) {
      await store.upsert(group);
    }

    const freshIds = new Set(records.map((record) => record.id));
    const staleIds = previousIds.filter((id) => !freshIds.has(id));
    if (staleIds.length > 0) {
      await store.deleteByIds(staleIds);
      logger.info('Removed stale chunks from a shortened document.', {
        docId: document.id,
        removed: staleIds.length,
      });
    }

    ingestedDocuments += 1;
    ingestedChunks += records.length;
    logger.info('Ingested document.', {
      docId: document.id,
      chunks: records.length,
      replaced: previousIds.length,
    });
  }

  logger.info('Ingest complete.', {
    documents: ingestedDocuments,
    submitted: documents.length,
    chunks: ingestedChunks,
    embeddingModel: embeddings.model,
    embeddingTokens: totalUsage.totalTokens,
  });

  // Counts what was actually indexed, not what was submitted: a document
  // that produced no chunks was not ingested, whatever the request said.
  return { ingestedDocuments, ingestedChunks };
}

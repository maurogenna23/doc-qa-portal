import type { Index, RecordMetadata } from '@pinecone-database/pinecone';
import { Pinecone } from '@pinecone-database/pinecone';
import { chunkIdPrefix } from '../core/chunking.js';
import { UpstreamError } from '../core/errors.js';
import type { ChunkMetadata, VectorMatch, VectorRecord, VectorStore } from '../core/ports.js';

export interface PineconeStoreOptions {
  apiKey: string;
  indexName: string;
  /** Optional logical partition. Useful to keep environments apart in one index. */
  namespace?: string;
}

export function createPineconeIndex({
  apiKey,
  indexName,
  namespace,
}: PineconeStoreOptions): Index<RecordMetadata> {
  const client = new Pinecone({ apiKey });
  const index = client.index(indexName);
  return namespace === undefined || namespace === '' ? index : index.namespace(namespace);
}

/** Vector metadata is external input: an older ingest may have written a different shape. */
function toChunkMetadata(raw: RecordMetadata | undefined): ChunkMetadata | null {
  if (raw === undefined) return null;

  const docId = raw['docId'];
  const title = raw['title'];
  const chunkText = raw['chunkText'];
  const chunkIndex = raw['chunkIndex'];

  if (typeof docId !== 'string' || typeof title !== 'string' || typeof chunkText !== 'string') {
    return null;
  }

  return {
    docId,
    title,
    chunkText,
    chunkIndex: typeof chunkIndex === 'number' ? chunkIndex : 0,
  };
}

/**
 * Pinecone implementation of the VectorStore port.
 *
 * Error messages here are written by us and carry no provider text. The SDK's
 * own message travels in `cause`, which the HTTP layer logs and never returns:
 * a rejected key produces a message naming the index and the internal endpoint,
 * and this API is public and unauthenticated.
 *
 * `listIdsByDocId` uses id-prefix listing rather than a metadata filter:
 * serverless indexes do not support delete-by-filter, and prefix listing is
 * exactly what the `${docId}#chunk-N` id convention was designed for.
 */
export class PineconeVectorStore implements VectorStore {
  constructor(private readonly index: Index<RecordMetadata>) {}

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await this.index.upsert({
        records: records.map((record) => ({
          id: record.id,
          values: record.values,
          metadata: {
            docId: record.metadata.docId,
            title: record.metadata.title,
            chunkText: record.metadata.chunkText,
            chunkIndex: record.metadata.chunkIndex,
          },
        })),
      });
    } catch (error) {
      throw new UpstreamError(
        'VECTOR_STORE_ERROR',
        `Failed to upsert ${records.length} vectors.`,
        error,
      );
    }
  }

  async query(vector: readonly number[], topK: number): Promise<VectorMatch[]> {
    try {
      const response = await this.index.query({
        vector: [...vector],
        topK,
        includeMetadata: true,
        includeValues: false,
      });

      const matches: VectorMatch[] = [];
      for (const match of response.matches ?? []) {
        const metadata = toChunkMetadata(match.metadata);
        // A vector we cannot attribute to a document cannot be cited, so it is
        // dropped rather than surfaced as an unattributed source.
        if (metadata === null) continue;
        matches.push({ id: match.id, score: match.score ?? 0, metadata });
      }
      return matches;
    } catch (error) {
      throw new UpstreamError('VECTOR_STORE_ERROR', 'Vector store query failed.', error);
    }
  }

  async listIdsByDocId(docId: string): Promise<string[]> {
    const prefix = chunkIdPrefix(docId);
    const ids: string[] = [];
    let paginationToken: string | undefined;

    try {
      do {
        const page = await this.index.listPaginated({
          prefix,
          ...(paginationToken === undefined ? {} : { paginationToken }),
        });

        for (const item of page.vectors ?? []) {
          if (item.id !== undefined) ids.push(item.id);
        }
        paginationToken = page.pagination?.next;
      } while (paginationToken !== undefined);
    } catch (error) {
      throw new UpstreamError(
        'VECTOR_STORE_ERROR',
        `Failed to list existing chunks for document "${docId}".`,
        error,
      );
    }

    return ids;
  }

  async deleteByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;

    try {
      await this.index.deleteMany({ ids: [...ids] });
    } catch (error) {
      throw new UpstreamError(
        'VECTOR_STORE_ERROR',
        `Failed to delete ${ids.length} stale vectors.`,
        error,
      );
    }
  }
}

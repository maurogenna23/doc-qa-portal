/**
 * The boundaries of the RAG core.
 *
 * Everything below is an interface the core depends on and an adapter
 * implements. The core never imports openai, @pinecone-database/pinecone or
 * any aws-sdk package, which is what makes it testable without network access
 * and swappable without a rewrite.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  /** One vector per input text, in the same order as the input. */
  vectors: number[][];
  usage: TokenUsage | undefined;
}

export interface EmbeddingProvider {
  readonly model: string;
  /** Must match the dimension of the vector store index. */
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

export interface CompletionRequest {
  system: string;
  user: string;
  /** Hard ceiling on generated tokens. Cost guardrail, not a style preference. */
  maxOutputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage | undefined;
}

export interface CompletionProvider {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

/** Metadata stored alongside every vector. Kept flat: most stores only allow scalars. */
export interface ChunkMetadata {
  docId: string;
  title: string;
  chunkText: string;
  chunkIndex: number;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: ChunkMetadata;
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity. Higher is closer. */
  score: number;
  metadata: ChunkMetadata;
}

export interface VectorStore {
  upsert(records: readonly VectorRecord[]): Promise<void>;
  query(vector: readonly number[], topK: number): Promise<VectorMatch[]>;
  /**
   * Every id belonging to a document, used to garbage-collect stale chunks on
   * re-ingest. Relies on the `${docId}#chunk-N` id convention.
   */
  listIdsByDocId(docId: string): Promise<string[]>;
  deleteByIds(ids: readonly string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Used by tests and by any code path where logging is not wired up. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

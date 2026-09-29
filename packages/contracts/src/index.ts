/**
 * The HTTP contract between the Next.js app and the Lambda-backed API.
 *
 * This package intentionally contains no runtime code and no dependencies:
 * it exists so the frontend and the backend cannot drift apart silently.
 */

// ---------------------------------------------------------------------------
// POST /ingest
// ---------------------------------------------------------------------------

export interface IngestDocumentInput {
  /** Stable, caller-supplied identifier. Re-ingesting the same id replaces the document. */
  id: string;
  title: string;
  /** Plain text. Chunking happens server-side. */
  content: string;
}

export interface IngestRequest {
  documents: IngestDocumentInput[];
}

/** Returned when the API ingests synchronously (default). */
export interface IngestCompletedResponse {
  status: 'completed';
  ingestedDocuments: number;
  ingestedChunks: number;
}

/**
 * Returned when the API runs in async mode (S3 + SQS + worker Lambda).
 * Chunk count is unknown at accept time, so it is explicitly null rather than 0.
 */
export interface IngestQueuedResponse {
  status: 'queued';
  ingestedDocuments: number;
  ingestedChunks: null;
  jobId: string;
}

export type IngestResponse = IngestCompletedResponse | IngestQueuedResponse;

// ---------------------------------------------------------------------------
// POST /ask
// ---------------------------------------------------------------------------

export interface AskRequest {
  question: string;
  /** Number of chunks to retrieve. Defaults to 3, clamped to 1..10. */
  topK?: number;
}

/** A document that actually contributed to the answer. */
export interface Source {
  docId: string;
  title: string;
}

export interface AskResponse {
  answer: string;
  sources: Source[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'EMBEDDING_PROVIDER_ERROR'
  | 'COMPLETION_PROVIDER_ERROR'
  | 'VECTOR_STORE_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** Field-level detail for INVALID_INPUT; omitted otherwise. */
  details?: string[];
}

export interface ApiErrorResponse {
  error: ApiError;
}

/** Narrowing helper shared by the web app and the tests. */
export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorResponse).error?.code === 'string'
  );
}

import { ConfigurationError } from './core/errors.js';

export type IngestMode = 'sync' | 'async';

export interface AppConfig {
  pinecone: {
    apiKey: string;
    indexName: string;
    namespace: string | undefined;
  };
  llm: {
    apiKey: string;
    baseUrl: string | undefined;
    embeddingModel: string;
    embeddingDimensions: number;
    completionModel: string;
  };
  guardrails: {
    maxOutputTokens: number;
    maxContextChars: number;
    minScore: number;
  };
  ingest: {
    mode: IngestMode;
    bucket: string | undefined;
    queueUrl: string | undefined;
  };
}

type Env = Record<string, string | undefined>;

function optional(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, key: string, missing: string[]): string {
  const value = optional(env, key);
  if (value === undefined) {
    missing.push(key);
    return '';
  }
  return value;
}

function numeric(env: Env, key: string, fallback: number, problems: string[]): number {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${key} must be a number, received "${raw}".`);
    return fallback;
  }
  return value;
}

/**
 * Reads configuration and reports everything that is wrong at once, by name.
 *
 * It runs on the first invocation of an execution environment and the result is
 * memoised by the container, so a misconfigured deployment fails on its first
 * request with a message that names the missing variables, rather than with an
 * anonymous 500 somewhere deeper in the stack.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const missing: string[] = [];
  const problems: string[] = [];

  const pineconeApiKey = required(env, 'PINECONE_API_KEY', missing);
  const pineconeIndex = required(env, 'PINECONE_INDEX', missing);
  const llmApiKey = required(env, 'LLM_API_KEY', missing);

  const rawMode = optional(env, 'INGEST_MODE') ?? 'sync';
  if (rawMode !== 'sync' && rawMode !== 'async') {
    problems.push(`INGEST_MODE must be "sync" or "async", received "${rawMode}".`);
  }
  const mode: IngestMode = rawMode === 'async' ? 'async' : 'sync';

  const bucket = optional(env, 'INGEST_BUCKET');
  const queueUrl = optional(env, 'INGEST_QUEUE_URL');
  if (mode === 'async') {
    if (bucket === undefined) missing.push('INGEST_BUCKET (required when INGEST_MODE=async)');
    if (queueUrl === undefined) missing.push('INGEST_QUEUE_URL (required when INGEST_MODE=async)');
  }

  const embeddingDimensions = numeric(env, 'EMBEDDING_DIMENSIONS', 1536, problems);
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    problems.push('EMBEDDING_DIMENSIONS must be a positive integer.');
  }

  if (missing.length > 0 || problems.length > 0) {
    const parts = [
      missing.length > 0 ? `Missing environment variables: ${missing.join(', ')}.` : '',
      ...problems,
    ].filter((part) => part.length > 0);
    throw new ConfigurationError(parts.join(' '));
  }

  return {
    pinecone: {
      apiKey: pineconeApiKey,
      indexName: pineconeIndex,
      namespace: optional(env, 'PINECONE_NAMESPACE'),
    },
    llm: {
      apiKey: llmApiKey,
      baseUrl: optional(env, 'LLM_BASE_URL'),
      embeddingModel: optional(env, 'EMBEDDING_MODEL') ?? 'text-embedding-3-small',
      embeddingDimensions,
      completionModel: optional(env, 'COMPLETION_MODEL') ?? 'gpt-4.1-mini',
    },
    guardrails: {
      maxOutputTokens: numeric(env, 'MAX_OUTPUT_TOKENS', 500, problems),
      maxContextChars: numeric(env, 'MAX_CONTEXT_CHARS', 8_000, problems),
      minScore: numeric(env, 'MIN_SCORE', 0, problems),
    },
    ingest: { mode, bucket, queueUrl },
  };
}

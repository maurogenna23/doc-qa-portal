import type { IngestDocumentInput } from '@docqa/contracts';
import { PayloadTooLargeError, ValidationError } from './errors.js';

/**
 * Cost and abuse guardrails, enforced before a single token is spent.
 *
 * The endpoints are intentionally unauthenticated (per the assignment), so
 * input limits plus API Gateway throttling are what stand between a public URL
 * and a surprise bill.
 */
export const LIMITS = {
  maxDocumentsPerRequest: 20,
  maxDocIdChars: 128,
  maxTitleChars: 256,
  maxContentChars: 50_000,
  maxQuestionChars: 1_000,
  minTopK: 1,
  maxTopK: 10,
  defaultTopK: 3,
} as const;

/**
 * Document ids end up inside vector ids as `${docId}#chunk-N`, so `#` is
 * reserved and anything that would make an id ambiguous is rejected up front.
 */
export const DOC_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Reads a required, non-empty, length-bounded string, accumulating problems instead of throwing. */
function readString(
  value: unknown,
  field: string,
  maxChars: number,
  problems: string[],
): string | null {
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string.`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    problems.push(`${field} must not be empty.`);
    return null;
  }
  if (trimmed.length > maxChars) {
    problems.push(`${field} must be at most ${maxChars} characters.`);
    return null;
  }
  return trimmed;
}

/**
 * Size guardrails run before shape validation so an oversized request is
 * rejected as 413 rather than producing a wall of 400-level field errors.
 */
function assertIngestSize(documents: readonly unknown[]): void {
  if (documents.length > LIMITS.maxDocumentsPerRequest) {
    throw new PayloadTooLargeError(
      `A request may contain at most ${LIMITS.maxDocumentsPerRequest} documents, received ${documents.length}.`,
    );
  }

  const oversized: string[] = [];
  documents.forEach((raw, index) => {
    const doc = asRecord(raw);
    const content = doc?.['content'];
    if (typeof content === 'string' && content.length > LIMITS.maxContentChars) {
      oversized.push(
        `documents[${index}].content is ${content.length} characters, limit is ${LIMITS.maxContentChars}.`,
      );
    }
  });

  if (oversized.length > 0) {
    throw new PayloadTooLargeError('One or more documents exceed the content size limit.', oversized);
  }
}

/** Parses and validates a POST /ingest body. Throws AppError subclasses on bad input. */
export function parseIngestRequest(body: unknown): IngestDocumentInput[] {
  const root = asRecord(body);
  if (root === null) {
    throw new ValidationError('Request body must be a JSON object.');
  }

  const documents = root['documents'];
  if (!Array.isArray(documents)) {
    throw new ValidationError('"documents" must be an array.');
  }
  if (documents.length === 0) {
    throw new ValidationError('"documents" must contain at least one document.');
  }

  assertIngestSize(documents);

  const problems: string[] = [];
  const parsed: IngestDocumentInput[] = [];
  const seenIds = new Set<string>();

  documents.forEach((raw, index) => {
    const doc = asRecord(raw);
    if (doc === null) {
      problems.push(`documents[${index}] must be an object.`);
      return;
    }

    const id = readString(doc['id'], `documents[${index}].id`, LIMITS.maxDocIdChars, problems);
    const title = readString(doc['title'], `documents[${index}].title`, LIMITS.maxTitleChars, problems);
    const content = readString(
      doc['content'],
      `documents[${index}].content`,
      LIMITS.maxContentChars,
      problems,
    );

    if (id !== null && !DOC_ID_PATTERN.test(id)) {
      problems.push(
        `documents[${index}].id may only contain letters, digits, and the characters . _ : -`,
      );
      return;
    }
    if (id !== null && seenIds.has(id)) {
      problems.push(
        `documents[${index}].id "${id}" appears more than once; the last write would silently win.`,
      );
      return;
    }
    if (id === null || title === null || content === null) return;

    seenIds.add(id);
    parsed.push({ id, title, content });
  });

  if (problems.length > 0) {
    throw new ValidationError('Invalid ingest request.', problems);
  }

  return parsed;
}

export interface ParsedAskRequest {
  question: string;
  topK: number;
}

/** Parses and validates a POST /ask body, applying the topK default and clamp. */
export function parseAskRequest(body: unknown): ParsedAskRequest {
  const root = asRecord(body);
  if (root === null) {
    throw new ValidationError('Request body must be a JSON object.');
  }

  const problems: string[] = [];
  const question = readString(root['question'], '"question"', LIMITS.maxQuestionChars, problems);

  const rawTopK = root['topK'];
  let topK: number = LIMITS.defaultTopK;
  if (rawTopK !== undefined && rawTopK !== null) {
    if (typeof rawTopK !== 'number' || !Number.isInteger(rawTopK)) {
      problems.push('"topK" must be an integer.');
    } else {
      // Clamped rather than rejected: a caller asking for 50 wants "as many as
      // you can give me", and silently capping is friendlier than a 400.
      topK = Math.min(Math.max(rawTopK, LIMITS.minTopK), LIMITS.maxTopK);
    }
  }

  if (problems.length > 0 || question === null) {
    throw new ValidationError('Invalid ask request.', problems);
  }

  return { question, topK };
}

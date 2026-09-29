import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { IngestDocumentInput } from '@docqa/contracts';
import { UpstreamError, ValidationError } from '../core/errors.js';

/**
 * Async ingest transport.
 *
 * The document body goes to S3 and only a pointer travels through SQS. SQS caps
 * a message at 256 KB while a document may be far larger, so passing the text
 * inline would impose an arbitrary limit that has nothing to do with the domain.
 *
 * The queue is FIFO and every message is grouped by its document id. That is
 * what makes concurrent re-ingest of the same document safe: SQS delivers one
 * message group to one consumer at a time, so two writes to the same id are
 * serialised rather than interleaving their list/upsert/delete steps. Different
 * documents remain fully parallel, because they are different groups.
 */

export interface IngestJobMessage {
  jobId: string;
  docId: string;
  bucket: string;
  key: string;
}

/** SQS accepts at most ten entries per batch. */
const SQS_BATCH_LIMIT = 10;

let s3: S3Client | undefined;
let sqs: SQSClient | undefined;

function s3Client(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}

function sqsClient(): SQSClient {
  sqs ??= new SQSClient({});
  return sqs;
}

export function objectKey(jobId: string, docId: string): string {
  return `ingest/${jobId}/${encodeURIComponent(docId)}.json`;
}

function batch<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Stages every document in S3 and queues a pointer to each.
 *
 * Both steps run in parallel rather than document by document: twenty
 * documents used to mean forty sequential AWS round trips inside the API
 * Gateway timeout that async ingest exists to stay under.
 *
 * Staging is at-least-once. A failure after some documents are already queued
 * leaves those queued, and the error names the ones that did not make it, so a
 * caller retrying the whole request re-queues only what it must — the
 * deduplication id makes a repeated document within the dedup window a no-op.
 */
export async function enqueueDocuments(
  documents: readonly IngestDocumentInput[],
  options: { jobId: string; bucket: string; queueUrl: string },
): Promise<void> {
  const staged = await Promise.allSettled(
    documents.map(async (document) => {
      const key = objectKey(options.jobId, document.id);
      await s3Client().send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: JSON.stringify(document),
          ContentType: 'application/json',
        }),
      );
      return { docId: document.id, key };
    }),
  );

  const failedToStage = documents
    .map((document, index) => ({ document, outcome: staged[index] }))
    .filter((entry) => entry.outcome?.status !== 'fulfilled')
    .map((entry) => entry.document.id);

  if (failedToStage.length > 0) {
    throw new UpstreamError(
      'INGEST_TRANSPORT_ERROR',
      `Failed to stage ${failedToStage.length} of ${documents.length} documents for ingest.`,
      new Error(`Documents not staged: ${failedToStage.join(', ')}.`),
    );
  }

  const messages: IngestJobMessage[] = staged.flatMap((outcome) =>
    outcome.status === 'fulfilled'
      ? [{ jobId: options.jobId, docId: outcome.value.docId, bucket: options.bucket, key: outcome.value.key }]
      : [],
  );

  const failedToQueue: string[] = [];

  for (const group of batch(messages, SQS_BATCH_LIMIT)) {
    let response;
    try {
      response = await sqsClient().send(
        new SendMessageBatchCommand({
          QueueUrl: options.queueUrl,
          Entries: group.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message),
            // Serialises writes to one document without serialising the rest.
            MessageGroupId: message.docId,
            // Makes a retry of the same job idempotent within the dedup window.
            MessageDeduplicationId: `${message.jobId}:${message.docId}`,
          })),
        }),
      );
    } catch (error) {
      throw new UpstreamError(
        'INGEST_TRANSPORT_ERROR',
        `Failed to enqueue ${group.length} documents.`,
        error,
      );
    }

    // A batch call can succeed as a whole while individual entries fail.
    for (const failure of response.Failed ?? []) {
      const index = Number(failure.Id);
      const message = Number.isInteger(index) ? group[index] : undefined;
      failedToQueue.push(message?.docId ?? `entry ${failure.Id ?? '?'}`);
    }
  }

  if (failedToQueue.length > 0) {
    throw new UpstreamError(
      'INGEST_TRANSPORT_ERROR',
      `Failed to enqueue ${failedToQueue.length} of ${documents.length} documents.`,
      new Error(`Documents not queued: ${failedToQueue.join(', ')}.`),
    );
  }
}

/** Parses an SQS message body into a job pointer. */
export function parseIngestJobMessage(body: string): IngestJobMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ValidationError('Queue message body is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Queue message body must be a JSON object.');
  }

  const { jobId, docId, bucket, key } = parsed as Record<string, unknown>;
  if (
    typeof jobId !== 'string' ||
    typeof docId !== 'string' ||
    typeof bucket !== 'string' ||
    typeof key !== 'string'
  ) {
    throw new ValidationError('Queue message is missing jobId, docId, bucket or key.');
  }

  return { jobId, docId, bucket, key };
}

/** Reads a staged document back out of S3. */
export async function fetchStagedDocument(message: IngestJobMessage): Promise<IngestDocumentInput> {
  let raw: string;
  try {
    const response = await s3Client().send(
      new GetObjectCommand({ Bucket: message.bucket, Key: message.key }),
    );
    raw = (await response.Body?.transformToString()) ?? '';
  } catch (error) {
    throw new UpstreamError(
      'INGEST_TRANSPORT_ERROR',
      `Failed to read staged document ${message.key}.`,
      error,
    );
  }

  return parseStagedDocument(raw, message.key);
}

/**
 * Parses a staged object's body. Separate from the S3 call so the parsing rules
 * can be tested without a network, which is where the one unguarded JSON.parse
 * in this file survived unnoticed.
 */
export function parseStagedDocument(raw: string, key: string): IngestDocumentInput {
  // An empty or truncated object would otherwise throw a raw SyntaxError out of
  // the worker, which the batch handler cannot classify and would retry three
  // times before the dead-letter queue.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(`Staged document ${key} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`Staged document ${key} is not a JSON object.`);
  }

  const { id, title, content } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof content !== 'string') {
    throw new ValidationError(`Staged document ${key} is missing id, title or content.`);
  }

  return { id, title, content };
}

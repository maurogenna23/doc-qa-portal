import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { IngestDocumentInput } from '@docqa/contracts';
import { UpstreamError, ValidationError } from '../core/errors.js';

/**
 * Async ingest transport.
 *
 * The document body goes to S3 and only a pointer travels through SQS. SQS caps
 * a message at 256 KB while a document may be far larger, so passing the text
 * inline would impose an arbitrary limit that has nothing to do with the domain.
 */

export interface IngestJobMessage {
  jobId: string;
  docId: string;
  bucket: string;
  key: string;
}

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

/** Writes one document to S3, then publishes a pointer to it. */
export async function enqueueDocument(
  document: IngestDocumentInput,
  options: { jobId: string; bucket: string; queueUrl: string },
): Promise<void> {
  const key = objectKey(options.jobId, document.id);

  try {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: JSON.stringify(document),
        ContentType: 'application/json',
      }),
    );
  } catch (error) {
    throw new UpstreamError(
      'VECTOR_STORE_ERROR',
      `Failed to stage document "${document.id}" in S3.`,
      error,
    );
  }

  const message: IngestJobMessage = {
    jobId: options.jobId,
    docId: document.id,
    bucket: options.bucket,
    key,
  };

  try {
    await sqsClient().send(
      new SendMessageCommand({
        QueueUrl: options.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  } catch (error) {
    throw new UpstreamError(
      'VECTOR_STORE_ERROR',
      `Failed to enqueue document "${document.id}".`,
      error,
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

  if (typeof parsed !== 'object' || parsed === null) {
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
export async function fetchStagedDocument(
  message: IngestJobMessage,
): Promise<IngestDocumentInput> {
  let raw: string;
  try {
    const response = await s3Client().send(
      new GetObjectCommand({ Bucket: message.bucket, Key: message.key }),
    );
    raw = (await response.Body?.transformToString()) ?? '';
  } catch (error) {
    throw new UpstreamError(
      'VECTOR_STORE_ERROR',
      `Failed to read staged document s3://${message.bucket}/${message.key}.`,
      error,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationError(`Staged document ${message.key} is not a JSON object.`);
  }

  const { id, title, content } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof content !== 'string') {
    throw new ValidationError(`Staged document ${message.key} is missing id, title or content.`);
  }

  return { id, title, content };
}

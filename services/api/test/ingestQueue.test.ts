import { describe, expect, it } from 'vitest';
import {
  objectKey,
  parseIngestJobMessage,
  parseStagedDocument,
} from '../src/adapters/ingestQueue.js';
import { ValidationError } from '../src/core/errors.js';

/**
 * The async transport had no tests at all, which is exactly where an unguarded
 * JSON.parse survived: a truncated S3 object threw a raw SyntaxError out of the
 * worker, so the batch handler could not classify it and SQS retried three
 * times before the dead-letter queue.
 */

describe('objectKey', () => {
  it('namespaces staged objects by job', () => {
    expect(objectKey('job-1', 'refund-policy')).toBe('ingest/job-1/refund-policy.json');
  });

  it('escapes a document id so it cannot alter the key path', () => {
    expect(objectKey('job-1', 'a/b')).toBe('ingest/job-1/a%2Fb.json');
  });
});

describe('parseIngestJobMessage', () => {
  const VALID = { jobId: 'job-1', docId: 'refund-policy', bucket: 'b', key: 'k' };

  it('reads a well-formed pointer', () => {
    expect(parseIngestJobMessage(JSON.stringify(VALID))).toEqual(VALID);
  });

  it.each([
    ['a truncated body', '{"jobId":"job-1"'],
    ['an empty body', ''],
    ['a JSON array', '["job-1"]'],
    ['a JSON scalar', '"job-1"'],
    ['a missing docId', JSON.stringify({ ...VALID, docId: undefined })],
    ['a non-string bucket', JSON.stringify({ ...VALID, bucket: 42 })],
  ])('rejects %s as a validation error rather than crashing', (_label, body) => {
    expect(() => parseIngestJobMessage(body)).toThrow(ValidationError);
  });
});

describe('parseStagedDocument', () => {
  const DOCUMENT = { id: 'refund-policy', title: 'Refund Policy', content: 'No refunds.' };

  it('reads a well-formed staged document', () => {
    expect(parseStagedDocument(JSON.stringify(DOCUMENT), 'k')).toEqual(DOCUMENT);
  });

  it.each([
    ['an empty object body', ''],
    ['a truncated object', '{"id":"refund-policy","title":'],
    ['a JSON array', '[]'],
    ['a missing content field', JSON.stringify({ id: 'a', title: 'A' })],
    ['a non-string title', JSON.stringify({ ...DOCUMENT, title: 7 })],
  ])('rejects %s as a validation error rather than crashing', (_label, raw) => {
    expect(() => parseStagedDocument(raw, 'ingest/job-1/doc.json')).toThrow(ValidationError);
  });

  it('names the offending object so a dead-letter message can be traced', () => {
    expect(() => parseStagedDocument('{', 'ingest/job-1/doc.json')).toThrow(
      /ingest\/job-1\/doc\.json/,
    );
  });
});

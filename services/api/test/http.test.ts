import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  PayloadTooLargeError,
  UpstreamError,
  ValidationError,
} from '../src/core/errors.js';
import { silentLogger, type LogFields, type Logger } from '../src/core/ports.js';
import { errorResponse, parseJsonBody } from '../src/http.js';

function event(body: string | undefined, isBase64Encoded = false): APIGatewayProxyEventV2 {
  return {
    ...(body === undefined ? {} : { body }),
    isBase64Encoded,
  } as APIGatewayProxyEventV2;
}

function parseBody(response: { body?: string | undefined }): {
  error: { code: string; message: string; details?: string[] };
} {
  return JSON.parse(response.body ?? '{}');
}

describe('parseJsonBody', () => {
  it('parses a JSON body', () => {
    expect(parseJsonBody(event('{"question":"hi"}'))).toEqual({ question: 'hi' });
  });

  it('decodes a base64 body, as API Gateway may deliver it', () => {
    const encoded = Buffer.from('{"question":"hi"}', 'utf8').toString('base64');

    expect(parseJsonBody(event(encoded, true))).toEqual({ question: 'hi' });
  });

  it.each([
    ['a missing body', undefined],
    ['an empty body', ''],
    ['a malformed body', '{"question":'],
  ])('rejects %s', (_label, body) => {
    expect(() => parseJsonBody(event(body))).toThrow(ValidationError);
  });
});

/** Captures what the handler logged, so tests can assert on both sides of the boundary. */
function recordingLogger(): Logger & { entries: { message: string; fields: LogFields }[] } {
  const entries: { message: string; fields: LogFields }[] = [];
  const record = (message: string, fields?: LogFields) => {
    entries.push({ message, fields: fields ?? {} });
  };
  return { entries, info: record, warn: record, error: record };
}

/** The message a provider SDK produces when it rejects a key: specific, and not ours to publish. */
const PROVIDER_MESSAGE =
  'The API key you provided was rejected while calling https://api.pinecone.io/indexes/doc-qa.';

describe('errorResponse', () => {
  it('maps invalid input to 400 and keeps the field details', () => {
    const response = errorResponse(new ValidationError('Bad.', ['id is required']), silentLogger);

    expect(response.statusCode).toBe(400);
    expect(parseBody(response).error).toEqual({
      code: 'INVALID_INPUT',
      message: 'Bad.',
      details: ['id is required'],
    });
  });

  it('maps an oversized request to 413', () => {
    expect(errorResponse(new PayloadTooLargeError('Too big.'), silentLogger).statusCode).toBe(413);
  });

  it('maps a provider failure to 502 so callers can tell it apart from their own mistake', () => {
    const response = errorResponse(
      new UpstreamError('VECTOR_STORE_ERROR', 'Pinecone is unreachable.'),
      silentLogger,
    );

    expect(response.statusCode).toBe(502);
    expect(parseBody(response).error.code).toBe('VECTOR_STORE_ERROR');
  });

  it('maps missing configuration to 500', () => {
    expect(errorResponse(new ConfigurationError('No key.'), silentLogger).statusCode).toBe(500);
  });

  it('never leaks an unexpected error message to the caller', () => {
    const response = errorResponse(new Error('pcsk_secret_key_leaked_in_stack'), silentLogger);

    expect(response.statusCode).toBe(500);
    expect(parseBody(response).error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
    });
    expect(response.body).not.toContain('pcsk_secret');
  });

  it('always sets CORS headers, including on failures', () => {
    const response = errorResponse(new ValidationError('Bad.'), silentLogger);

    expect(response.headers?.['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('errorResponse and third-party error text', () => {
  // Regression guard for a false claim in the README. The Pinecone adapter used
  // to interpolate the SDK's own message into UpstreamError, and errorResponse
  // returns `message` verbatim, so a rejected key handed an unauthenticated
  // caller the index name and the internal endpoint. The earlier test only
  // exercised the non-AppError branch, so it passed while the property was
  // false, which is worse than having no test at all.

  it('never returns a provider message to the caller', () => {
    const error = new UpstreamError(
      'VECTOR_STORE_ERROR',
      'Vector store query failed.',
      new Error(PROVIDER_MESSAGE),
    );

    const response = errorResponse(error, silentLogger);

    expect(response.body).not.toContain('api.pinecone.io');
    expect(response.body).not.toContain('rejected');
    expect(parseBody(response).error.message).toBe('Vector store query failed.');
  });

  it('does log the provider message, so the detail is not simply lost', () => {
    const logger = recordingLogger();

    errorResponse(
      new UpstreamError('VECTOR_STORE_ERROR', 'Vector store query failed.', new Error(PROVIDER_MESSAGE)),
      logger,
    );

    const [entry] = logger.entries;
    expect(entry).toBeDefined();
    expect(entry!.fields['cause']).toBe(PROVIDER_MESSAGE);
  });

  it('reports async transport failures under their own code, not the vector store one', () => {
    const response = errorResponse(
      new UpstreamError('INGEST_TRANSPORT_ERROR', 'Failed to enqueue document "a".'),
      silentLogger,
    );

    expect(response.statusCode).toBe(502);
    expect(parseBody(response).error.code).toBe('INGEST_TRANSPORT_ERROR');
  });
});

import type { ApiErrorResponse } from '@docqa/contracts';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isAppError, ValidationError } from './core/errors.js';
import type { Logger } from './core/ports.js';

/**
 * The HTTP boundary: everything that knows about API Gateway lives here, so the
 * handlers stay a few lines of wiring and the core stays transport-agnostic.
 */

/**
 * CORS is also configured on the HTTP API itself, which is what answers
 * preflight. These headers cover the actual response and keep the local dev
 * server behaving identically to the deployed one.
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
};

export function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

/** Decodes and parses the request body, rejecting anything that is not JSON. */
export function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined || event.body.length === 0) {
    throw new ValidationError('Request body is required.');
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
}

/**
 * Maps a thrown value to a response.
 *
 * Known failures keep their code, status and detail so the caller can act on
 * them. Anything unrecognised becomes a generic 500: an unexpected error may
 * carry a stack trace or a provider payload, which belongs in the log, not in
 * an HTTP response body.
 */
export function errorResponse(error: unknown, logger: Logger): APIGatewayProxyStructuredResultV2 {
  if (isAppError(error)) {
    logger.warn('Request failed.', {
      code: error.code,
      statusCode: error.statusCode,
      reason: error.message,
    });

    const body: ApiErrorResponse = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: [...error.details] }),
      },
    };
    return jsonResponse(error.statusCode, body);
  }

  logger.error('Unhandled error.', {
    reason: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  const body: ApiErrorResponse = {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
  };
  return jsonResponse(500, body);
}

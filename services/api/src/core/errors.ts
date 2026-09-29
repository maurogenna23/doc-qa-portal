import type { ApiErrorCode } from '@docqa/contracts';

interface AppErrorParams {
  code: ApiErrorCode;
  message: string;
  statusCode: number;
  details?: readonly string[];
  cause?: unknown;
}

/**
 * The single error type the core throws. Handlers map it to an HTTP response;
 * nothing else in the codebase needs to know about status codes.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: readonly string[] | undefined;

  constructor({ code, message, statusCode, details, cause }: AppErrorParams) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** The caller sent something we cannot act on. Never retried. */
export class ValidationError extends AppError {
  constructor(message: string, details?: readonly string[]) {
    super({
      code: 'INVALID_INPUT',
      message,
      statusCode: 400,
      ...(details === undefined ? {} : { details }),
    });
  }
}

/** The caller sent a well-formed request that exceeds our cost guardrails. */
export class PayloadTooLargeError extends AppError {
  constructor(message: string, details?: readonly string[]) {
    super({
      code: 'PAYLOAD_TOO_LARGE',
      message,
      statusCode: 413,
      ...(details === undefined ? {} : { details }),
    });
  }
}

/**
 * A third-party service failed. Surfaced as 502 so callers can distinguish
 * "your request was wrong" from "our dependency is having a bad day".
 */
export class UpstreamError extends AppError {
  constructor(
    code: Extract<
      ApiErrorCode,
      | 'EMBEDDING_PROVIDER_ERROR'
      | 'COMPLETION_PROVIDER_ERROR'
      | 'VECTOR_STORE_ERROR'
      | 'INGEST_TRANSPORT_ERROR'
    >,
    message: string,
    cause?: unknown,
  ) {
    super({ code, message, statusCode: 502, cause });
  }
}

/** The process is missing configuration it cannot run without. */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super({ code: 'CONFIGURATION_ERROR', message, statusCode: 500 });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Extracts a loggable message from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

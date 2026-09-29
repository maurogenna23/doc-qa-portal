import type {
  AskRequest,
  AskResponse,
  IngestDocumentInput,
  IngestResponse,
} from '@docqa/contracts';
import { isApiErrorResponse, isAskResponse, isIngestResponse } from '@docqa/contracts';

const BASE_URL = (process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

/** An error the API reported deliberately, as opposed to a network failure. */
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function post<T>(path: string, body: unknown, isExpected: (value: unknown) => value is T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(
      'NETWORK_ERROR',
      `Could not reach the API at ${BASE_URL}. Is it running?`,
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw new ApiRequestError(
        payload.error.code,
        payload.error.message,
        payload.error.details ?? [],
      );
    }
    throw new ApiRequestError('INTERNAL_ERROR', `Request failed with status ${response.status}.`);
  }

  // A 2xx whose body is not what the contract promises is still a failure, and
  // surfacing it as one beats returning a value the UI will silently render as
  // nothing at all.
  if (!isExpected(payload)) {
    throw new ApiRequestError(
      'INTERNAL_ERROR',
      'The API returned a response that does not match the expected shape.',
    );
  }

  return payload;
}

export function ingestDocuments(documents: IngestDocumentInput[]): Promise<IngestResponse> {
  return post('/ingest', { documents }, isIngestResponse);
}

export function askQuestion(request: AskRequest): Promise<AskResponse> {
  return post('/ask', request, isAskResponse);
}

export { BASE_URL };

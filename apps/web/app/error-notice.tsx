'use client';

import { ApiRequestError } from '@/lib/api';

/** Renders whatever went wrong, including the field-level detail the API returns. */
export function ErrorNotice({ error }: { error: unknown }) {
  const isApiError = error instanceof ApiRequestError;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const details = isApiError ? error.details : [];

  return (
    <div className="notice error" role="alert">
      <strong>
        {message} {isApiError && <code>{error.code}</code>}
      </strong>
      {details.length > 0 && (
        <ul>
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

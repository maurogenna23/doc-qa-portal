'use client';

import type { IngestDocumentInput, IngestResponse } from '@docqa/contracts';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ingestDocuments } from '@/lib/api';
import { ErrorNotice } from '../error-notice';

/** Local editor state: one entry per document card, with a stable key for React. */
interface DocumentDraft extends IngestDocumentInput {
  key: string;
}

/**
 * Card keys are derived from React's useId rather than crypto.randomUUID.
 *
 * A random id is generated once during the server render and again during
 * hydration, so the `id`/`htmlFor` pair on every field disagreed between the two
 * and React reported a hydration mismatch. useId is stable across both.
 */
function emptyDraft(key: string): DocumentDraft {
  return { key, id: '', title: '', content: '' };
}

function summarise(result: IngestResponse): string {
  if (result.status === 'queued') {
    return `Queued ${result.ingestedDocuments} document(s) for background ingest. Job ${result.jobId}.`;
  }
  return `Ingested ${result.ingestedDocuments} document(s) into ${result.ingestedChunks} chunk(s).`;
}

export default function DocumentsPage() {
  const baseId = useId();
  // Cards added after the first exist only on the client, so a counter is safe.
  const nextCard = useRef(1);
  const [drafts, setDrafts] = useState<DocumentDraft[]>(() => [emptyDraft(`${baseId}-0`)]);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const addCard = () => emptyDraft(`${baseId}-${nextCard.current++}`);

  function update(key: string, field: keyof IngestDocumentInput, value: string) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, [field]: value } : draft)),
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);

    try {
      const response = await ingestDocuments(
        drafts.map(({ id, title, content }) => ({ id, title, content })),
      );
      setResult(response);
      setDrafts([addCard()]);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  const incomplete = drafts.some(
    (draft) =>
      draft.id.trim().length === 0 ||
      draft.title.trim().length === 0 ||
      draft.content.trim().length === 0,
  );

  return (
    <>
      <h1>Add documents</h1>
      <p className="lede">
        Plain text only. Re-using a document id replaces that document rather than adding a second
        copy of it.
      </p>

      <form onSubmit={handleSubmit}>
        {drafts.map((draft, index) => (
          <article className="card" key={draft.key}>
            <div className="card-head">
              <span className="card-index">Document {index + 1}</span>
              {drafts.length > 1 && (
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    setDrafts((current) => current.filter((item) => item.key !== draft.key))
                  }
                >
                  Remove
                </button>
              )}
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor={`id-${draft.key}`}>Id</label>
                <input
                  id={`id-${draft.key}`}
                  value={draft.id}
                  onChange={(event) => update(draft.key, 'id', event.target.value)}
                  placeholder="refund-policy"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor={`title-${draft.key}`}>Title</label>
                <input
                  id={`title-${draft.key}`}
                  value={draft.title}
                  onChange={(event) => update(draft.key, 'title', event.target.value)}
                  placeholder="Refund Policy"
                  required
                />
              </div>
            </div>

            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`content-${draft.key}`}>Content</label>
              <textarea
                id={`content-${draft.key}`}
                value={draft.content}
                onChange={(event) => update(draft.key, 'content', event.target.value)}
                placeholder="Full refund within 30 days with receipt. No refunds on digital goods."
                rows={6}
                required
              />
            </div>
          </article>
        ))}

        <div className="actions">
          <button type="submit" disabled={pending || incomplete}>
            {pending ? 'Ingesting…' : 'Ingest'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setDrafts((current) => [...current, addCard()])}
          >
            Add another
          </button>
        </div>
      </form>

      {error !== null && <ErrorNotice error={error} />}

      {result !== null && (
        <div className="notice ok" role="status">
          {summarise(result)}
        </div>
      )}
    </>
  );
}

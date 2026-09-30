'use client';

import { LIMITS, type IngestDocumentInput, type IngestResponse } from '@docqa/contracts';
import { useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ingestDocuments } from '@/lib/api';
import {
  ACCEPTED_FILE_TYPES,
  deriveDocumentId,
  deriveTitle,
  extractText,
  FileExtractionError,
  SUPPORTED_EXTENSIONS,
} from '@/lib/extract';
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

function isBlank(draft: DocumentDraft): boolean {
  return (
    draft.id.trim().length === 0 ||
    draft.title.trim().length === 0 ||
    draft.content.trim().length === 0
  );
}

function summarise(result: IngestResponse): string {
  if (result.status === 'queued') {
    return `Queued ${result.ingestedDocuments} document(s) for background ingest. Job ${result.jobId}.`;
  }

  const base = `Ingested ${result.ingestedDocuments} document(s) into ${result.ingestedChunks} chunk(s).`;
  // Replacing is intended, but it destroys the previous version, so it is
  // reported rather than folded into the same sentence as a first write.
  return result.replacedDocuments > 0
    ? `${base} ${result.replacedDocuments} replaced a document already in the index.`
    : base;
}

export default function DocumentsPage() {
  const baseId = useId();
  // Cards added after the first exist only on the client, so a counter is safe.
  const nextCard = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<DocumentDraft[]>(() => [emptyDraft(`${baseId}-0`)]);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileProblems, setFileProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const addCard = () => emptyDraft(`${baseId}-${nextCard.current++}`);

  function update(key: string, field: keyof IngestDocumentInput, value: string) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, [field]: value } : draft)),
    );
  }

  /**
   * Turns dropped files into cards.
   *
   * Each file gets its own card with the id and title derived from its name, so
   * the result is editable rather than submitted behind the user's back. Files
   * are read in parallel and reported individually: one unreadable scan should
   * not discard the four documents beside it.
   */
  async function handleFiles(files: FileList | null) {
    if (files === null || files.length === 0) return;

    setReading(true);
    setError(null);
    setResult(null);

    // Refuse the surplus before parsing rather than after. Dropping thirty
    // files used to parse all thirty and then fail at the API with a 413.
    const room = LIMITS.maxDocumentsPerRequest - drafts.filter((d) => !isBlank(d)).length;
    const selected = Array.from(files);
    const accepted = room > 0 ? selected.slice(0, room) : [];
    const rejected = selected.slice(accepted.length);

    setFileProblems(
      rejected.length === 0
        ? []
        : [
            `${rejected.length} file(s) not read: a request may contain at most ${LIMITS.maxDocumentsPerRequest} documents. Ingest these first, then add the rest.`,
          ],
    );

    const outcomes = await Promise.all(
      accepted.map(async (file) => {
        try {
          return { file, content: await extractText(file) };
        } catch (caught) {
          const message =
            caught instanceof FileExtractionError
              ? `${caught.fileName}: ${caught.message}`
              : `${file.name}: could not be read.`;
          return { file, problem: message };
        }
      }),
    );

    const added: DocumentDraft[] = [];
    const problems: string[] = [];

    for (const outcome of outcomes) {
      if ('problem' in outcome && outcome.problem !== undefined) {
        problems.push(outcome.problem);
        continue;
      }
      if (!('content' in outcome)) continue;

      added.push({
        ...addCard(),
        id: deriveDocumentId(outcome.file.name),
        title: deriveTitle(outcome.file.name),
        content: outcome.content,
      });
    }

    // Replace the untouched starter card rather than leaving it empty above the
    // files, which would block submission on a card the user never filled in.
    setDrafts((current) => {
      const kept = current.filter((draft) => !isBlank(draft));
      const next = [...kept, ...added];
      return next.length > 0 ? next : [addCard()];
    });
    setFileProblems((current) => [...current, ...problems]);
    setReading(false);
    if (fileInput.current !== null) fileInput.current.value = '';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
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
      setFileProblems([]);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  const incomplete = drafts.some(isBlank);

  // Two cards with one id is not an error the API will accept, and it is easy
  // to create by hand. Saying so here beats a 400 naming an array index.
  const duplicateIds = [
    ...new Set(
      drafts
        .map((draft) => draft.id.trim())
        .filter((id, index, all) => id.length > 0 && all.indexOf(id) !== index),
    ),
  ];

  return (
    <>
      <h1>Add documents</h1>
      <p className="lede">
        Drop a file or type the text in. Re-using a document id replaces that document rather than
        adding a second copy of it.
      </p>

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileInput}
          id="files"
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          onChange={(event) => void handleFiles(event.target.files)}
          hidden
        />
        <p className="dropzone-title">
          {reading ? 'Reading files…' : 'Drop files here'}
        </p>
        <p className="hint">
          {SUPPORTED_EXTENSIONS.join(', ')} — text is extracted in your browser, so the file itself
          never leaves this page.
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() => fileInput.current?.click()}
          disabled={reading}
        >
          Choose files
        </button>
      </div>

      {fileProblems.length > 0 && (
        <div className="notice error" role="alert">
          <strong>Some files could not be read</strong>
          <ul>
            {fileProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

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
              <label htmlFor={`content-${draft.key}`}>
                Content
                {draft.content.length > 0 && (
                  <span className="char-count"> {draft.content.length.toLocaleString()} characters</span>
                )}
              </label>
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

        {duplicateIds.length > 0 && (
          <div className="notice error" role="alert">
            <strong>Two documents share an id</strong>
            <ul>
              {duplicateIds.map((id) => (
                <li key={id}>
                  <code>{id}</code> — only the last one would be kept. Give them different ids.
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="actions">
          <button type="submit" disabled={pending || incomplete || duplicateIds.length > 0}>
            {pending ? 'Ingesting…' : 'Ingest'}
          </button>
          <button type="button" className="secondary" onClick={() => setDrafts((c) => [...c, addCard()])}>
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

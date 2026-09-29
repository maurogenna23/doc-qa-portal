'use client';

import type { AskResponse } from '@docqa/contracts';
import { useState, type FormEvent } from 'react';
import { askQuestion } from '@/lib/api';
import { ErrorNotice } from './error-notice';

/** Mirrors the API's own limits; the server clamps too. */
const MIN_TOP_K = 1;
const MAX_TOP_K = 10;
const DEFAULT_TOP_K = 3;

export default function AskPage() {
  const [question, setQuestion] = useState('');
  // Held as text, not as a number.
  //
  // `Number('')` is 0, so clearing the field to retype wrote a 0 the input's own
  // min={1} then rejected: the browser blocked the submit before onSubmit ever
  // ran, and the page did nothing at all — no answer, no error, no request.
  // Range is enforced here and again by the API, not by markup that can veto a
  // submit silently.
  const [topK, setTopK] = useState('3');
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  /** Falls back to the default when the field is empty, and clamps to the API's range. */
  function resolvedTopK(): number {
    const parsed = Number.parseInt(topK, 10);
    if (Number.isNaN(parsed)) return DEFAULT_TOP_K;
    return Math.min(Math.max(parsed, MIN_TOP_K), MAX_TOP_K);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setAnswer(null);

    const effectiveTopK = resolvedTopK();
    // Show what was actually sent, rather than leaving a value on screen that
    // does not match the request.
    setTopK(String(effectiveTopK));

    try {
      setAnswer(await askQuestion({ question, topK: effectiveTopK }));
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1>Ask your documents</h1>
      <p className="lede">
        Questions are answered only from the documents you have ingested. Every answer lists the
        documents it came from.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="question">Question</label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Can I get a refund on a digital product?"
            rows={3}
            required
            maxLength={1000}
          />
        </div>

        <div className="field" style={{ maxWidth: '10rem' }}>
          <label htmlFor="topK">Passages to retrieve</label>
          <input
            id="topK"
            type="number"
            inputMode="numeric"
            value={topK}
            onChange={(event) => setTopK(event.target.value)}
            aria-describedby="topK-hint"
          />
          <p className="hint" id="topK-hint">
            Between {MIN_TOP_K} and {MAX_TOP_K}. Defaults to {DEFAULT_TOP_K}.
          </p>
        </div>

        <div className="actions">
          <button type="submit" disabled={pending || question.trim().length === 0}>
            {pending ? 'Thinking…' : 'Ask'}
          </button>
        </div>
      </form>

      {error !== null && <ErrorNotice error={error} />}

      {answer !== null && (
        <section className="answer" aria-live="polite">
          <p className="answer-body">{answer.answer}</p>

          {answer.sources.length > 0 ? (
            <>
              <h2 className="sources-title">Sources</h2>
              <ul className="sources">
                {answer.sources.map((source) => (
                  <li key={source.docId}>
                    <span>{source.title}</span>
                    <span className="doc-id">{source.docId}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">
              No document supported an answer. Add documents on the Documents page, or rephrase the
              question.
            </p>
          )}
        </section>
      )}
    </>
  );
}

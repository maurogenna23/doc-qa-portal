'use client';

import type { AskResponse } from '@docqa/contracts';
import { useState, type FormEvent } from 'react';
import { askQuestion } from '@/lib/api';
import { ErrorNotice } from './error-notice';

export default function AskPage() {
  const [question, setQuestion] = useState('');
  const [topK, setTopK] = useState(3);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setAnswer(null);

    try {
      setAnswer(await askQuestion({ question, topK }));
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
            min={1}
            max={10}
            value={topK}
            onChange={(event) => setTopK(Number(event.target.value))}
          />
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

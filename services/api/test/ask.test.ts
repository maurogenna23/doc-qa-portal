import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../src/core/ask.js';
import type { ChunkingOptions } from '../src/core/chunking.js';
import { ingestDocuments } from '../src/core/ingest.js';
import { NO_CONTEXT_ANSWER } from '../src/core/prompt.js';
import { FakeCompletionProvider, FakeEmbeddingProvider, FakeVectorStore } from './support/fakes.js';

const chunking: ChunkingOptions = { maxChunkChars: 200, overlapChars: 40, maxChunksPerDocument: 50 };

async function seededStore(): Promise<FakeVectorStore> {
  const store = new FakeVectorStore();
  await ingestDocuments({ embeddings: new FakeEmbeddingProvider(), store, chunking }, [
    {
      id: 'refund-policy',
      title: 'Refund Policy',
      content: 'Full refund within 30 days with receipt. No refunds on digital goods.',
    },
    {
      id: 'shipping',
      title: 'Shipping Policy',
      content: 'Shipping fees are never refunded once an order has left the warehouse.',
    },
  ]);
  return store;
}

describe('answerQuestion', () => {
  it('answers from the retrieved chunks and cites the documents behind them', async () => {
    const completions = new FakeCompletionProvider('Digital products are not eligible for refunds.');

    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions,
        store: await seededStore(),
      },
      { question: 'Can I get a refund on a digital product?', topK: 3 },
    );

    expect(response.answer).toBe('Digital products are not eligible for refunds.');
    expect(response.sources.length).toBeGreaterThan(0);
    expect(response.sources.map((source) => source.docId)).toContain('refund-policy');
  });

  it('reports each source once even when several of its chunks were retrieved', async () => {
    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions: new FakeCompletionProvider(),
        store: await seededStore(),
      },
      { question: 'refund', topK: 10 },
    );

    const docIds = response.sources.map((source) => source.docId);
    expect(new Set(docIds).size).toBe(docIds.length);
  });

  it('refuses without paying for a completion when the index is empty', async () => {
    const completions = new FakeCompletionProvider();

    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions,
        store: new FakeVectorStore(),
      },
      { question: 'Can I get a refund?', topK: 3 },
    );

    expect(response).toEqual({ answer: NO_CONTEXT_ANSWER, sources: [] });
    expect(completions.requests).toHaveLength(0);
  });

  it('refuses without a completion when every match falls below the score floor', async () => {
    const completions = new FakeCompletionProvider();

    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions,
        store: await seededStore(),
        minScore: 1.1,
      },
      { question: 'Can I get a refund?', topK: 3 },
    );

    expect(response.answer).toBe(NO_CONTEXT_ANSWER);
    expect(completions.requests).toHaveLength(0);
  });

  it('cites nothing when the model itself says the documents do not answer the question', async () => {
    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions: new FakeCompletionProvider(NO_CONTEXT_ANSWER),
        store: await seededStore(),
      },
      { question: 'What is the CEO salary?', topK: 3 },
    );

    expect(response).toEqual({ answer: NO_CONTEXT_ANSWER, sources: [] });
  });

  it('never cites a document that did not fit the context budget', async () => {
    const completions = new FakeCompletionProvider();

    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions,
        store: await seededStore(),
        maxContextChars: 80,
      },
      { question: 'refund', topK: 10 },
    );

    expect(response.sources).toHaveLength(1);
    const [request] = completions.requests;
    expect(request).toBeDefined();
    expect(request!.user).toContain(response.sources[0]!.docId);
  });

  it('caps the generated answer length as a cost guardrail', async () => {
    const completions = new FakeCompletionProvider();

    await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions,
        store: await seededStore(),
        maxOutputTokens: 123,
      },
      { question: 'refund', topK: 3 },
    );

    expect(completions.requests[0]?.maxOutputTokens).toBe(123);
  });

  it('falls back to the refusal when the model returns an empty answer', async () => {
    const response = await answerQuestion(
      {
        embeddings: new FakeEmbeddingProvider(),
        completions: new FakeCompletionProvider('   '),
        store: await seededStore(),
      },
      { question: 'refund', topK: 3 },
    );

    expect(response).toEqual({ answer: NO_CONTEXT_ANSWER, sources: [] });
  });
});

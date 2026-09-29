import { describe, expect, it } from 'vitest';
import { buildPrompt, collectSources, NO_CONTEXT_ANSWER, SYSTEM_PROMPT } from '../src/core/prompt.js';
import type { VectorMatch } from '../src/core/ports.js';

function match(docId: string, title: string, chunkText: string, score: number): VectorMatch {
  return {
    id: `${docId}#chunk-1`,
    score,
    metadata: { docId, title, chunkText, chunkIndex: 0 },
  };
}

const REFUNDS = match('refund-policy', 'Refund Policy', 'No refunds on digital goods.', 0.91);
const SHIPPING = match('shipping', 'Shipping Policy', 'Shipping fees are never refunded.', 0.74);

describe('buildPrompt', () => {
  it('puts every retrieved passage in the user message with its document attribution', () => {
    const prompt = buildPrompt('Can I get a refund?', [REFUNDS, SHIPPING], 8_000);

    expect(prompt.user).toContain('No refunds on digital goods.');
    expect(prompt.user).toContain('Shipping fees are never refunded.');
    expect(prompt.user).toContain('refund-policy');
    expect(prompt.user).toContain('Can I get a refund?');
    expect(prompt.usedMatches).toHaveLength(2);
  });

  it('numbers passages from one, in retrieval order', () => {
    const prompt = buildPrompt('Anything?', [REFUNDS, SHIPPING], 8_000);

    expect(prompt.user.indexOf('[1]')).toBeLessThan(prompt.user.indexOf('[2]'));
    expect(prompt.user).toContain('[1] Refund Policy (docId: refund-policy)');
  });

  it('instructs the model to refuse instead of guessing', () => {
    const prompt = buildPrompt('Anything?', [REFUNDS], 8_000);

    expect(prompt.system).toBe(SYSTEM_PROMPT);
    expect(prompt.system).toContain(NO_CONTEXT_ANSWER);
    expect(prompt.system).toContain('ONLY');
  });

  it('drops passages that do not fit the context budget', () => {
    const prompt = buildPrompt('Can I get a refund?', [REFUNDS, SHIPPING], 90);

    expect(prompt.usedMatches).toEqual([REFUNDS]);
    expect(prompt.user).not.toContain('Shipping fees are never refunded.');
  });

  it('always includes the best match, even when it alone exceeds the budget', () => {
    const prompt = buildPrompt('Can I get a refund?', [REFUNDS, SHIPPING], 1);

    expect(prompt.usedMatches).toEqual([REFUNDS]);
    expect(prompt.user).toContain('No refunds on digital goods.');
  });
});

describe('collectSources', () => {
  it('reports one source per document, in relevance order', () => {
    expect(collectSources([REFUNDS, SHIPPING])).toEqual([
      { docId: 'refund-policy', title: 'Refund Policy' },
      { docId: 'shipping', title: 'Shipping Policy' },
    ]);
  });

  it('collapses several chunks of the same document into one source', () => {
    const secondChunk = match('refund-policy', 'Refund Policy', 'Full refund within 30 days.', 0.8);

    expect(collectSources([REFUNDS, secondChunk, SHIPPING])).toEqual([
      { docId: 'refund-policy', title: 'Refund Policy' },
      { docId: 'shipping', title: 'Shipping Policy' },
    ]);
  });

  it('returns nothing when nothing was retrieved', () => {
    expect(collectSources([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  collectSources,
  NO_CONTEXT_ANSWER,
  parseAnswer,
  SYSTEM_PROMPT,
} from '../src/core/prompt.js';
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

  it('gives the model the exact refusal string and asks it to cite its passages', () => {
    const prompt = buildPrompt('Anything?', [REFUNDS], 8_000);

    expect(prompt.system).toBe(SYSTEM_PROMPT);
    expect(prompt.system).toContain(NO_CONTEXT_ANSWER);
    expect(prompt.system).toContain('citations');
  });

  it('does not ban comprehension outright, which made the model refuse paraphrases', () => {
    // Regression guard. An earlier prompt said "never guess", and the model
    // refused to answer a question about "a digital product" from a passage
    // about "digital goods" — three of eight evaluation cases failed that way.
    // The behavioural check lives in `npm run eval`; this only stops the
    // wording that caused it from coming back.
    expect(SYSTEM_PROMPT).not.toContain('never guess');
    expect(SYSTEM_PROMPT).toContain('different words');
  });

  it('keeps the prompt and the code agreeing on the exact refusal string', () => {
    // ask.ts compares the model's answer against this constant to decide
    // whether to drop the sources; a drifting string would break that silently.
    expect(SYSTEM_PROMPT).toContain(NO_CONTEXT_ANSWER);
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

describe('parseAnswer', () => {
  const shown = [REFUNDS, SHIPPING];

  it('reads the answer and resolves citations back to the passages used', () => {
    const result = parseAnswer('{"answer":"No refunds on digital goods.","citations":[1]}', shown);

    expect(result.answer).toBe('No refunds on digital goods.');
    expect(result.citedMatches).toEqual([REFUNDS]);
  });

  it('tolerates a reply wrapped in a markdown code fence', () => {
    const raw = '```json\n{"answer":"Yes.","citations":[2]}\n```';

    expect(parseAnswer(raw, shown).citedMatches).toEqual([SHIPPING]);
  });

  it('ignores citations that point at a passage the model was never shown', () => {
    const result = parseAnswer('{"answer":"Yes.","citations":[1,7,0,-2]}', shown);

    expect(result.citedMatches).toEqual([REFUNDS]);
  });

  it('collapses a repeated citation', () => {
    expect(parseAnswer('{"answer":"Yes.","citations":[1,1,1]}', shown).citedMatches).toEqual([
      REFUNDS,
    ]);
  });

  it('cites nothing when the model cites nothing', () => {
    expect(parseAnswer('{"answer":"Yes.","citations":[]}', shown).citedMatches).toEqual([]);
  });

  it('finds the JSON object when the model answers in prose and appends it', () => {
    // Observed against a real provider: the answer text, a blank line, then
    // the object, despite the prompt asking for the object alone.
    const raw =
      'You cannot get a refund on a digital product.\n\n' +
      '{"answer":"You cannot get a refund on a digital product.","citations":[1]}';

    const result = parseAnswer(raw, shown);

    expect(result.answer).toBe('You cannot get a refund on a digital product.');
    expect(result.citedMatches).toEqual([REFUNDS]);
    expect(result.answer).not.toContain('citations');
  });

  it('finds the JSON object when the model prefaces it with commentary', () => {
    const raw = 'Here is the result:\n{"answer":"Yes.","citations":[2]}';

    expect(parseAnswer(raw, shown).citedMatches).toEqual([SHIPPING]);
  });

  it('degrades to a plain answer citing everything shown when the reply is not JSON', () => {
    const result = parseAnswer('No refunds on digital goods.', shown);

    expect(result.answer).toBe('No refunds on digital goods.');
    expect(result.citedMatches).toEqual(shown);
  });

  it('degrades the same way when the JSON is the wrong shape', () => {
    expect(parseAnswer('["not","an","object"]', shown).citedMatches).toEqual(shown);
    expect(parseAnswer('{"reply":"wrong key"}', shown).citedMatches).toEqual(shown);
  });

  it('keeps the answer but cites everything when citations are not an array', () => {
    const result = parseAnswer('{"answer":"Yes.","citations":"one"}', shown);

    expect(result.answer).toBe('Yes.');
    expect(result.citedMatches).toEqual(shown);
  });
});

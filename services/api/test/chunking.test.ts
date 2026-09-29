import { describe, expect, it } from 'vitest';
import {
  chunkId,
  chunkText,
  DEFAULT_CHUNKING_OPTIONS,
  type ChunkingOptions,
} from '../src/core/chunking.js';
import { PayloadTooLargeError } from '../src/core/errors.js';

const options: ChunkingOptions = { maxChunkChars: 120, overlapChars: 30, maxChunksPerDocument: 50 };

const POLICY = [
  'Full refund within 30 days with receipt.',
  'No refunds on digital goods.',
  'Shipping fees are never refunded.',
  'Exchanges are handled by the store that sold the item.',
].join(' ');

/**
 * The longest suffix of `previous` that is also a prefix of `next` \u2014 the text the
 * two chunks literally share. Asserting on this is stricter than looking for a
 * repeated word, and it is the property overlap is supposed to guarantee.
 */
function sharedBoundary(previous: string, next: string): string {
  const longest = Math.min(previous.length, next.length);
  for (let length = longest; length > 0; length -= 1) {
    const candidate = next.slice(0, length);
    if (previous.endsWith(candidate)) return candidate;
  }
  return '';
}

describe('chunkText', () => {
  it('returns no chunks for content that is empty or only whitespace', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('keeps short content as a single chunk', () => {
    const chunks = chunkText('Full refund within 30 days with receipt.', options);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('Full refund within 30 days with receipt.');
    expect(chunks[0]?.index).toBe(0);
  });

  it('is deterministic: the same input always produces the same chunks', () => {
    expect(chunkText(POLICY, options)).toEqual(chunkText(POLICY, options));
  });

  it('respects the maximum chunk size', () => {
    for (const chunk of chunkText(POLICY, options)) {
      expect(chunk.text.length).toBeLessThanOrEqual(options.maxChunkChars);
    }
  });

  it('numbers chunks consecutively from zero', () => {
    const chunks = chunkText(POLICY, options);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  });

  it('overlaps every consecutive pair of chunks so a boundary answer stays retrievable', () => {
    const chunks = chunkText(POLICY, options);
    expect(chunks.length).toBeGreaterThan(1);

    for (const [position, chunk] of chunks.slice(0, -1).entries()) {
      const next = chunks[position + 1];
      expect(next).toBeDefined();

      const shared = sharedBoundary(chunk.text, next!.text);
      expect(shared.length).toBeGreaterThan(0);
      expect(shared.length).toBeLessThanOrEqual(options.overlapChars);
    }
  });

  it('splits on sentence boundaries rather than mid-word', () => {
    for (const chunk of chunkText(POLICY, options)) {
      expect(chunk.text).not.toMatch(/^\s/);
      expect(chunk.text).not.toMatch(/\s$/);
    }
  });

  it('hard-splits a single sentence longer than a whole chunk', () => {
    const runOn = `${'word '.repeat(60).trim()}.`;
    const chunks = chunkText(runOn, options);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(options.maxChunkChars);
    }
  });

  it('collapses redundant whitespace without merging paragraphs into words', () => {
    const chunks = chunkText('First   paragraph.\n\n\n\nSecond    paragraph.', options);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('First paragraph. Second paragraph.');
  });

  it('refuses a document that would exceed the per-document chunk ceiling', () => {
    const tiny: ChunkingOptions = { maxChunkChars: 20, overlapChars: 0, maxChunksPerDocument: 3 };

    expect(() => chunkText(POLICY, tiny)).toThrow(PayloadTooLargeError);
  });

  it('caps the overlap at half a chunk so splitting always makes progress', () => {
    const greedy: ChunkingOptions = {
      maxChunkChars: 60,
      overlapChars: 500,
      maxChunksPerDocument: 100,
    };

    const chunks = chunkText(POLICY, greedy);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(POLICY.length);
  });

  it('keeps an overlap for sentences too long to leave room for the full one', () => {
    // Regression guard. The carry used the whole overlap when it fit and none
    // at all when it did not, so prose made of long sentences — legal and
    // policy text, the plausible corpus here — chunked with no overlap at all.
    const options: ChunkingOptions = {
      maxChunkChars: 800,
      overlapChars: 150,
      maxChunksPerDocument: 100,
    };

    let counter = 0;
    const sentence = (length: number): string => {
      const words: string[] = [];
      while (words.join(' ').length < length - 1) words.push(`w${counter++}`);
      return `${words.join(' ').slice(0, length - 1)}.`;
    };

    for (const length of [700, 750, 790]) {
      counter = 0;
      const chunks = chunkText([sentence(length), sentence(length), sentence(length)].join(' '), options);
      expect(chunks.length).toBeGreaterThan(1);

      for (const [position, chunk] of chunks.slice(0, -1).entries()) {
        const shared = sharedBoundary(chunk.text, chunks[position + 1]!.text);
        expect(shared.length).toBeGreaterThan(0);
      }
    }
  });

  it('reaches zero overlap only when one sentence nearly fills a whole chunk', () => {
    const options: ChunkingOptions = {
      maxChunkChars: 800,
      overlapChars: 150,
      maxChunksPerDocument: 100,
    };

    let counter = 0;
    const sentence = (length: number): string => {
      const words: string[] = [];
      while (words.join(' ').length < length - 1) words.push(`w${counter++}`);
      return `${words.join(' ').slice(0, length - 1)}.`;
    };

    const overlapAt = (length: number): number => {
      counter = 0;
      const chunks = chunkText([sentence(length), sentence(length), sentence(length)].join(' '), options);
      const first = chunks[0];
      const second = chunks[1];
      if (first === undefined || second === undefined) return -1;
      return sharedBoundary(first.text, second.text).length;
    };

    // The ramp degrades rather than cliff-edging, and only bottoms out when a
    // single sentence leaves no room beside itself.
    expect(overlapAt(650)).toBeGreaterThan(100);
    expect(overlapAt(750)).toBeGreaterThan(0);
    expect(overlapAt(790)).toBeGreaterThan(0);
    expect(overlapAt(799)).toBe(0);
  });

  it('never exceeds the chunk size while carrying a partial overlap', () => {
    const options: ChunkingOptions = {
      maxChunkChars: 800,
      overlapChars: 150,
      maxChunksPerDocument: 100,
    };

    let counter = 0;
    const words: string[] = [];
    while (words.join(' ').length < 4_000) words.push(`word${counter++}`);
    const text = words.join(' ').replace(/((?:\S+\s){90})/g, '$1. ');

    for (const chunk of chunkText(text, options)) {
      expect(chunk.text.length).toBeLessThanOrEqual(options.maxChunkChars);
    }
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_CHUNKING_OPTIONS.overlapChars).toBeLessThan(
      DEFAULT_CHUNKING_OPTIONS.maxChunkChars / 2,
    );
  });
});

describe('chunkId', () => {
  it('builds a stable, 1-based id namespaced by document', () => {
    expect(chunkId('refund-policy', 0)).toBe('refund-policy#chunk-1');
    expect(chunkId('refund-policy', 3)).toBe('refund-policy#chunk-4');
  });

  it('produces the same id for the same position every time', () => {
    expect(chunkId('refund-policy', 2)).toBe(chunkId('refund-policy', 2));
  });
});

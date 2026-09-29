import { PayloadTooLargeError, ValidationError } from './errors.js';

export interface ChunkingOptions {
  /** Upper bound on chunk length, in characters. */
  maxChunkChars: number;
  /** Characters repeated from the end of the previous chunk. Capped at half a chunk. */
  overlapChars: number;
  /** Defensive ceiling so one document cannot trigger unbounded embedding calls. */
  maxChunksPerDocument: number;
}

/**
 * Defaults chosen for plain-text policy/FAQ documents:
 * ~800 characters is roughly 150-200 tokens, small enough that a retrieved
 * chunk is mostly signal, large enough to keep a paragraph's argument intact.
 * The 150-character overlap keeps an answer that straddles a boundary
 * retrievable from either side.
 */
export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxChunkChars: 800,
  overlapChars: 150,
  maxChunksPerDocument: 200,
};

export interface Chunk {
  /** Zero-based position within the document. */
  index: number;
  text: string;
}

/**
 * Vector id for a chunk. Deterministic on purpose: re-ingesting the same
 * document produces the same ids, so the store updates in place instead of
 * accumulating duplicates. The ordinal is 1-based to match the assignment's
 * `refund-policy#chunk-1` example.
 *
 * `#` is reserved as the separator, which is why document ids may not contain it.
 */
export function chunkId(docId: string, index: number): string {
  return `${docId}#chunk-${index + 1}`;
}

/** Prefix that matches every chunk of a document, used to garbage-collect stale chunks. */
export function chunkIdPrefix(docId: string): string {
  return `${docId}#`;
}

/** Collapses runs of spaces and blank lines without destroying paragraph breaks. */
function normalizeWhitespace(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits after sentence-ending punctuation followed by whitespace. */
function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Last resort for a single sentence longer than a whole chunk. Cuts on word boundaries. */
function hardSplit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const lastSpace = rest.slice(0, maxChars).lastIndexOf(' ');
    const cut = lastSpace > 0 ? lastSpace : maxChars;
    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/** Trailing slice of a chunk, snapped forward to the next word boundary. */
function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length === 0) return '';
  if (text.length <= overlapChars) return text;

  const tail = text.slice(text.length - overlapChars);
  const firstSpace = tail.indexOf(' ');
  return (firstSpace === -1 ? tail : tail.slice(firstSpace + 1)).trim();
}

/**
 * Splits plain text into overlapping chunks, preferring paragraph and sentence
 * boundaries over arbitrary character cuts.
 *
 * The function is pure and deterministic: the same input always yields the same
 * chunks, which is what makes stable vector ids possible.
 */
export function chunkText(
  content: string,
  options: ChunkingOptions = DEFAULT_CHUNKING_OPTIONS,
): Chunk[] {
  const { maxChunkChars, maxChunksPerDocument } = options;
  if (!Number.isInteger(maxChunkChars) || maxChunkChars <= 0) {
    throw new ValidationError('maxChunkChars must be a positive integer.');
  }

  // Overlap is capped at half a chunk. Beyond that, a chunk could be mostly
  // repeated text and the splitter would stop making forward progress.
  const overlap = Math.max(0, Math.min(options.overlapChars, Math.floor(maxChunkChars / 2)));

  const normalized = normalizeWhitespace(content);
  if (normalized.length === 0) return [];

  // Break the document down to the smallest units we are willing to split on.
  const pieces: string[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    for (const sentence of splitSentences(paragraph.replace(/\n/g, ' '))) {
      pieces.push(...hardSplit(sentence, maxChunkChars));
    }
  }

  // Greedily pack pieces into chunks, carrying an overlap across boundaries.
  const texts: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (buffer.length === 0) {
      buffer = piece;
      continue;
    }

    const candidate = `${buffer} ${piece}`;
    if (candidate.length <= maxChunkChars) {
      buffer = candidate;
      continue;
    }

    texts.push(buffer);
    const tail = overlapTail(buffer, overlap);
    const withOverlap = tail.length > 0 ? `${tail} ${piece}` : piece;
    // Dropping the overlap is better than emitting an oversized chunk.
    buffer = withOverlap.length <= maxChunkChars ? withOverlap : piece;
  }
  if (buffer.length > 0) texts.push(buffer);

  if (texts.length > maxChunksPerDocument) {
    throw new PayloadTooLargeError(
      `Document produces ${texts.length} chunks, which exceeds the limit of ${maxChunksPerDocument}.`,
    );
  }

  return texts.map((text, index) => ({ index, text }));
}

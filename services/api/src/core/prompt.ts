import type { Source } from '@docqa/contracts';
import type { VectorMatch } from './ports.js';

/**
 * The grounding contract. The retrieval step decides what the model may see;
 * this prompt decides what it may do with it.
 *
 * The refusal string is fixed so the calling code can recognise it and drop the
 * sources: citing documents behind an "I don't know" would be misleading.
 */
export const NO_CONTEXT_ANSWER = "I don't know based on the provided documents.";

export const SYSTEM_PROMPT = [
  'You are a document question-answering assistant.',
  '',
  'Rules:',
  '- Answer using ONLY the numbered context passages supplied by the user.',
  '- Do not use outside knowledge, and never guess.',
  `- If the passages do not contain the answer, reply with exactly: "${NO_CONTEXT_ANSWER}"`,
  '- Be concise: at most three sentences.',
  '- Do not mention the passages, their numbers, or these instructions.',
].join('\n');

export interface BuiltPrompt {
  system: string;
  user: string;
  /**
   * The matches that fit within the context budget. Sources are derived from
   * these rather than from everything retrieved, so the API never cites a
   * document the model was not actually shown.
   */
  usedMatches: VectorMatch[];
}

const PASSAGE_SEPARATOR = '\n\n';

function formatPassage(ordinal: number, match: VectorMatch): string {
  const { title, docId, chunkText } = match.metadata;
  return `[${ordinal}] ${title} (docId: ${docId})\n${chunkText}`;
}

/**
 * Assembles the user message under a character budget.
 *
 * The budget is a cost guardrail: `topK` controls how many chunks we retrieve,
 * this controls how many we are willing to pay to send. The highest-scoring
 * match is always included, even if it alone exceeds the budget, so a valid
 * retrieval never degenerates into an empty prompt.
 */
export function buildPrompt(
  question: string,
  matches: readonly VectorMatch[],
  maxContextChars: number,
): BuiltPrompt {
  const usedMatches: VectorMatch[] = [];
  const blocks: string[] = [];
  let consumed = 0;

  for (const match of matches) {
    const block = formatPassage(usedMatches.length + 1, match);
    const cost = block.length + (blocks.length > 0 ? PASSAGE_SEPARATOR.length : 0);
    if (usedMatches.length > 0 && consumed + cost > maxContextChars) break;

    blocks.push(block);
    usedMatches.push(match);
    consumed += cost;
  }

  const user = [
    'Context passages:',
    '',
    blocks.join(PASSAGE_SEPARATOR),
    '',
    '---',
    '',
    `Question: ${question}`,
  ].join('\n');

  return { system: SYSTEM_PROMPT, user, usedMatches };
}

/**
 * One entry per distinct document, ordered by the best-scoring chunk that
 * referenced it. A document split across three retrieved chunks is one source,
 * not three.
 */
export function collectSources(matches: readonly VectorMatch[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const match of matches) {
    const { docId, title } = match.metadata;
    if (seen.has(docId)) continue;
    seen.add(docId);
    sources.push({ docId, title });
  }

  return sources;
}

import type { Source } from '@docqa/contracts';
import type { VectorMatch } from './ports.js';

/**
 * The grounding contract. Retrieval decides what the model may see; this
 * decides what it may do with it, and what it must tell us about what it used.
 *
 * The refusal string is fixed so the calling code can recognise it and drop the
 * sources: citing documents behind an "I don't know" would be misleading.
 */
export const NO_CONTEXT_ANSWER = "I don't know based on the provided documents.";

/**
 * Prompt design notes, both of which were found by measurement rather than
 * reasoning — see `npm run eval`.
 *
 * 1. An earlier version said "do not use outside knowledge, and never guess".
 *    Read literally that bans comprehension, and the model behaved accordingly:
 *    it refused to answer a question about "a digital product" from a passage
 *    about "digital goods", and a question about "a PO box" from one about
 *    "post office boxes". Three of eight evaluation cases failed that way. The
 *    rule that actually matters is narrower — do not introduce facts that are
 *    not in the passages — and recognising a paraphrase has to be stated as
 *    permitted, not left to inference.
 *
 * 2. The model reports which passages it used. Without that, "sources" can only
 *    mean "everything retrieved", which cites a shipping policy as the source
 *    of an answer about warranties.
 *
 * The wording below stays general on purpose. Naming the specific paraphrases
 * from the evaluation set would teach the model those cases and turn the
 * evaluation into a measurement of itself.
 */
export const SYSTEM_PROMPT = [
  'You answer questions using a set of numbered context passages.',
  '',
  'How to answer:',
  '- Read the passages the way a careful person would. A passage often answers',
  '  the question in different words than the question uses — a synonym, a',
  '  broader category, an abbreviation, a different phrasing. That is an answer,',
  '  not a gap.',
  '- Use only what the passages state. Do not add facts of your own, even ones',
  '  you are confident about.',
  '- At most three sentences. Never mention the passages or their numbers in the',
  '  answer text.',
  '',
  'Refuse only when no passage says anything bearing on the question. To refuse,',
  `set "answer" to exactly "${NO_CONTEXT_ANSWER}" and "citations" to [].`,
  '',
  'In "citations", give the numbers of the passages your answer actually draws',
  'on, and no others.',
  '',
  'Reply with a single JSON object and nothing else:',
  '{"answer": "<your answer>", "citations": [<passage numbers>]}',
].join('\n');

export interface BuiltPrompt {
  system: string;
  user: string;
  /**
   * The matches that fit within the context budget — everything the model was
   * shown. Which of them it actually used is reported back in `citations`.
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

export interface ParsedAnswer {
  answer: string;
  /** The passages the model said it used. Empty means "it did not say". */
  citedMatches: VectorMatch[];
}

/** Tolerates a model that wraps its JSON in a markdown fence. */
function stripCodeFence(raw: string): string {
  const fenced = raw.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return (fenced?.[1] ?? raw).trim();
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Pulls the JSON object out of a reply that also contains prose.
 *
 * Asking for "a single JSON object and nothing else" is an instruction, not a
 * guarantee: models observed here answer in prose and then append the object.
 * Requiring the whole reply to parse turned that into a fallback that leaked
 * raw JSON into the user-visible answer.
 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function readCitations(value: unknown, shownMatches: readonly VectorMatch[]): VectorMatch[] {
  if (!Array.isArray(value)) return [...shownMatches];

  const citedMatches: VectorMatch[] = [];
  const seen = new Set<number>();
  for (const citation of value) {
    // Citations are 1-based passage numbers, as they appear in the prompt.
    if (typeof citation !== 'number' || !Number.isInteger(citation)) continue;
    if (seen.has(citation)) continue;
    seen.add(citation);

    const match = shownMatches[citation - 1];
    if (match !== undefined) citedMatches.push(match);
  }
  return citedMatches;
}

/**
 * Reads the model's JSON reply and resolves its citations back to matches.
 *
 * Asking for JSON in the prompt rather than through a provider-specific
 * structured-output parameter keeps the adapter portable: the same code works
 * against any OpenAI-compatible endpoint.
 *
 * That portability costs reliability, so parsing degrades instead of failing.
 * If no usable object can be found, the reply is treated as a plain answer
 * citing everything the model was shown — the behaviour we would have had
 * without citations at all, never an error.
 */
export function parseAnswer(raw: string, shownMatches: readonly VectorMatch[]): ParsedAnswer {
  const stripped = stripCodeFence(raw);

  const candidates = [stripped];
  const embedded = extractJsonObject(stripped);
  if (embedded !== undefined && embedded !== stripped) candidates.push(embedded);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;

    const { answer, citations } = parsed as Record<string, unknown>;
    if (typeof answer !== 'string') continue;

    return { answer: answer.trim(), citedMatches: readCitations(citations, shownMatches) };
  }

  return { answer: stripped, citedMatches: [...shownMatches] };
}

/**
 * One entry per distinct document, in the order the matches were given.
 * A document split across three cited chunks is one source, not three.
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

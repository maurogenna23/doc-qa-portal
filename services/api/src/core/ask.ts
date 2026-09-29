import type { AskResponse } from '@docqa/contracts';
import { UpstreamError } from './errors.js';
import { buildPrompt, collectSources, NO_CONTEXT_ANSWER } from './prompt.js';
import {
  silentLogger,
  type CompletionProvider,
  type EmbeddingProvider,
  type Logger,
  type VectorStore,
} from './ports.js';

export interface AskDeps {
  embeddings: EmbeddingProvider;
  completions: CompletionProvider;
  store: VectorStore;
  logger?: Logger;
  maxContextChars?: number;
  maxOutputTokens?: number;
  /**
   * Minimum cosine score for a chunk to reach the prompt. Disabled by default:
   * a fixed threshold is a blunt instrument whose right value depends on the
   * embedding model and the corpus, and the prompt already instructs the model
   * to refuse when the passages do not answer the question. Exposed so it can
   * be tuned per deployment rather than guessed here.
   */
  minScore?: number;
}

export interface AskInput {
  question: string;
  topK: number;
}

export const DEFAULT_MAX_CONTEXT_CHARS = 8_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 500;
export const DEFAULT_MIN_SCORE = 0;

/**
 * Answers a question from the indexed documents.
 *
 * The empty-retrieval path returns the refusal without calling the LLM: there
 * is nothing to ground an answer in, so paying for a completion would buy a
 * hallucination.
 */
export async function answerQuestion(deps: AskDeps, input: AskInput): Promise<AskResponse> {
  const {
    embeddings,
    completions,
    store,
    logger = silentLogger,
    maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    minScore = DEFAULT_MIN_SCORE,
  } = deps;

  const embedded = await embeddings.embed([input.question]);
  const questionVector = embedded.vectors[0];
  if (questionVector === undefined) {
    throw new UpstreamError(
      'EMBEDDING_PROVIDER_ERROR',
      'Embedding provider returned no vector for the question.',
    );
  }

  const matches = await store.query(questionVector, input.topK);
  const relevant = matches.filter((match) => match.score >= minScore);

  if (relevant.length === 0) {
    logger.info('No matching chunks; skipped the completion call.', {
      question: input.question,
      topK: input.topK,
      retrieved: matches.length,
    });
    return { answer: NO_CONTEXT_ANSWER, sources: [] };
  }

  const prompt = buildPrompt(input.question, relevant, maxContextChars);
  const completion = await completions.complete({
    system: prompt.system,
    user: prompt.user,
    maxOutputTokens,
  });

  const answer = completion.text.trim();
  if (answer.length === 0) {
    logger.warn('Completion provider returned an empty answer.', { model: completions.model });
    return { answer: NO_CONTEXT_ANSWER, sources: [] };
  }

  logger.info('Answered question.', {
    topK: input.topK,
    retrieved: matches.length,
    used: prompt.usedMatches.length,
    completionModel: completions.model,
    completionTokens: completion.usage?.totalTokens,
  });

  // A refusal cites nothing: listing sources behind "I don't know" would imply
  // those documents were relevant when the model just told us they were not.
  if (answer === NO_CONTEXT_ANSWER) {
    return { answer, sources: [] };
  }

  return { answer, sources: collectSources(prompt.usedMatches) };
}

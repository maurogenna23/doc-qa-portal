import OpenAI from 'openai';
import { UpstreamError } from '../core/errors.js';
import type {
  CompletionProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingProvider,
  EmbeddingResult,
  TokenUsage,
} from '../core/ports.js';

/**
 * OpenAI-compatible adapters.
 *
 * Nothing here is OpenAI-specific beyond the SDK: pointing `baseURL` at Groq,
 * Together or OpenRouter swaps the provider without touching the core, which is
 * the reason the core talks to ports instead of to a vendor.
 */

export interface OpenAIClientOptions {
  apiKey: string;
  /** Override for an OpenAI-compatible provider. Omit to use api.openai.com. */
  baseURL?: string;
}

export function createOpenAIClient({ apiKey, baseURL }: OpenAIClientOptions): OpenAI {
  return new OpenAI({
    apiKey,
    ...(baseURL === undefined ? {} : { baseURL }),
    // Lambda has a hard timeout; failing fast beats being killed mid-retry.
    timeout: 30_000,
    maxRetries: 2,
  });
}

function toTokenUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

export interface OpenAIEmbeddingOptions {
  client: OpenAI;
  model: string;
  dimensions: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly client: OpenAI;

  constructor({ client, model, dimensions }: OpenAIEmbeddingOptions) {
    this.client = client;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: undefined };
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: [...texts],
        // Asking for the dimension explicitly means a model/index mismatch
        // fails at the provider rather than silently writing bad vectors.
        dimensions: this.dimensions,
      });

      // The API documents the order but does not guarantee it on the wire.
      const ordered = [...response.data].sort((a, b) => a.index - b.index);

      return {
        vectors: ordered.map((item) => item.embedding),
        usage: toTokenUsage(response.usage),
      };
    } catch (error) {
      throw new UpstreamError(
        'EMBEDDING_PROVIDER_ERROR',
        `Embedding request failed for model "${this.model}".`,
        error,
      );
    }
  }
}

export interface OpenAICompletionOptions {
  client: OpenAI;
  model: string;
}

export class OpenAICompletionProvider implements CompletionProvider {
  readonly model: string;
  private readonly client: OpenAI;

  constructor({ client, model }: OpenAICompletionOptions) {
    this.client = client;
    this.model = model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        // Extraction, not creative writing: the same documents and question
        // should produce the same answer.
        temperature: 0,
        max_completion_tokens: request.maxOutputTokens,
      });

      const choice = response.choices[0];
      if (choice === undefined) {
        throw new UpstreamError(
          'COMPLETION_PROVIDER_ERROR',
          'Completion provider returned no choices.',
        );
      }

      return {
        text: choice.message.content ?? '',
        usage: response.usage === undefined ? undefined : toTokenUsage(response.usage),
      };
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(
        'COMPLETION_PROVIDER_ERROR',
        `Completion request failed for model "${this.model}".`,
        error,
      );
    }
  }
}

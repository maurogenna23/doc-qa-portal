import { createJsonLogger } from './adapters/logger.js';
import {
  createOpenAIClient,
  OpenAICompletionProvider,
  OpenAIEmbeddingProvider,
} from './adapters/openai.js';
import { createPineconeIndex, PineconeVectorStore } from './adapters/pinecone.js';
import { loadConfig, type AppConfig } from './config.js';
import type { CompletionProvider, EmbeddingProvider, Logger, VectorStore } from './core/ports.js';

export interface Container {
  config: AppConfig;
  embeddings: EmbeddingProvider;
  completions: CompletionProvider;
  store: VectorStore;
  logger: Logger;
}

export function buildContainer(config: AppConfig = loadConfig()): Container {
  const openai = createOpenAIClient({
    apiKey: config.llm.apiKey,
    ...(config.llm.baseUrl === undefined ? {} : { baseURL: config.llm.baseUrl }),
  });

  const index = createPineconeIndex({
    apiKey: config.pinecone.apiKey,
    indexName: config.pinecone.indexName,
    ...(config.pinecone.namespace === undefined ? {} : { namespace: config.pinecone.namespace }),
  });

  return {
    config,
    embeddings: new OpenAIEmbeddingProvider({
      client: openai,
      model: config.llm.embeddingModel,
      dimensions: config.llm.embeddingDimensions,
    }),
    completions: new OpenAICompletionProvider({ client: openai, model: config.llm.completionModel }),
    store: new PineconeVectorStore(index),
    logger: createJsonLogger({ service: 'doc-qa' }),
  };
}

let cached: Container | undefined;

/**
 * Built once per execution environment, not once per request.
 *
 * Lambda reuses a warm container across invocations, so the HTTP clients and
 * their connection pools should outlive a single request. Cold-start cost is
 * paid once; every warm invocation reuses this.
 */
export function getContainer(): Container {
  cached ??= buildContainer();
  return cached;
}

/** Test seam: drops the memoised container so a new configuration takes effect. */
export function resetContainer(): void {
  cached = undefined;
}

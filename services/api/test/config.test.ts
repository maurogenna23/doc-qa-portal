import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigurationError } from '../src/core/errors.js';

const MINIMAL = {
  PINECONE_API_KEY: 'pcsk_test',
  PINECONE_INDEX: 'doc-qa',
  LLM_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('names every missing variable, not just the first one', () => {
    try {
      loadConfig({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const { message } = error as ConfigurationError;
      expect(message).toContain('PINECONE_API_KEY');
      expect(message).toContain('PINECONE_INDEX');
      expect(message).toContain('LLM_API_KEY');
    }
  });

  it('treats a blank value as missing rather than as a valid empty key', () => {
    expect(() => loadConfig({ ...MINIMAL, LLM_API_KEY: '   ' })).toThrow(ConfigurationError);
  });

  it('applies defaults for everything optional', () => {
    const config = loadConfig(MINIMAL);

    expect(config.llm.embeddingModel).toBe('text-embedding-3-small');
    expect(config.llm.embeddingDimensions).toBe(1536);
    expect(config.llm.completionModel).toBe('gpt-4.1-mini');
    expect(config.guardrails.maxOutputTokens).toBe(500);
    expect(config.guardrails.maxContextChars).toBe(8_000);
    expect(config.ingest.mode).toBe('sync');
  });

  it('rejects an unrecognised ingest mode instead of silently falling back', () => {
    expect(() => loadConfig({ ...MINIMAL, INGEST_MODE: 'eventual' })).toThrow(ConfigurationError);
  });

  it('requires the bucket and the queue when async ingest is enabled', () => {
    expect(() => loadConfig({ ...MINIMAL, INGEST_MODE: 'async' })).toThrow(ConfigurationError);

    const config = loadConfig({
      ...MINIMAL,
      INGEST_MODE: 'async',
      INGEST_BUCKET: 'bucket',
      INGEST_QUEUE_URL: 'https://sqs.example/queue',
    });
    expect(config.ingest).toEqual({
      mode: 'async',
      bucket: 'bucket',
      queueUrl: 'https://sqs.example/queue',
    });
  });

  it('rejects a non-numeric embedding dimension', () => {
    expect(() => loadConfig({ ...MINIMAL, EMBEDDING_DIMENSIONS: 'large' })).toThrow(
      ConfigurationError,
    );
  });

  it('carries the optional namespace and base URL through when set', () => {
    const config = loadConfig({
      ...MINIMAL,
      PINECONE_NAMESPACE: 'staging',
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    });

    expect(config.pinecone.namespace).toBe('staging');
    expect(config.llm.baseUrl).toBe('https://api.groq.com/openai/v1');
  });
});

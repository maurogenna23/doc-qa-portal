#!/usr/bin/env node
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { DocQaStack, type IngestMode } from '../lib/doc-qa-stack';

/**
 * Entry point.
 *
 * Configuration comes from the same .env the local server reads, so there is
 * one place to set a key rather than two that can disagree. Values may also be
 * supplied as CDK context (`cdk deploy -c PINECONE_API_KEY=...`) for CI, where
 * a .env file would be the wrong mechanism.
 */

const ENV_FILE = path.join(__dirname, '..', '..', '.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const app = new App();

function setting(name: string): string | undefined {
  const fromContext = app.node.tryGetContext(name);
  const value = typeof fromContext === 'string' ? fromContext : process.env[name];
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function requiredSetting(name: string): string {
  const value = setting(name);
  if (value === undefined) {
    throw new Error(
      `Missing ${name}. Set it in .env at the repository root, or pass it with "cdk deploy -c ${name}=...".`,
    );
  }
  return value;
}

const rawMode = setting('INGEST_MODE') ?? 'sync';
if (rawMode !== 'sync' && rawMode !== 'async') {
  throw new Error(`INGEST_MODE must be "sync" or "async", received "${rawMode}".`);
}
const ingestMode: IngestMode = rawMode;

new DocQaStack(app, 'DocQaStack', {
  description: 'Doc Q&A portal: HTTP API, Lambdas and optional async ingest pipeline',
  env: {
    ...(process.env['CDK_DEFAULT_ACCOUNT'] === undefined
      ? {}
      : { account: process.env['CDK_DEFAULT_ACCOUNT'] }),
    ...(process.env['CDK_DEFAULT_REGION'] === undefined
      ? {}
      : { region: process.env['CDK_DEFAULT_REGION'] }),
  },
  pineconeApiKey: requiredSetting('PINECONE_API_KEY'),
  pineconeIndex: requiredSetting('PINECONE_INDEX'),
  ...(setting('PINECONE_NAMESPACE') === undefined
    ? {}
    : { pineconeNamespace: requiredSetting('PINECONE_NAMESPACE') }),
  llmApiKey: requiredSetting('LLM_API_KEY'),
  ...(setting('LLM_BASE_URL') === undefined ? {} : { llmBaseUrl: requiredSetting('LLM_BASE_URL') }),
  embeddingModel: setting('EMBEDDING_MODEL') ?? 'text-embedding-3-small',
  embeddingDimensions: setting('EMBEDDING_DIMENSIONS') ?? '1536',
  completionModel: setting('COMPLETION_MODEL') ?? 'gpt-4.1-mini',
  maxOutputTokens: setting('MAX_OUTPUT_TOKENS') ?? '500',
  maxContextChars: setting('MAX_CONTEXT_CHARS') ?? '8000',
  minScore: setting('MIN_SCORE') ?? '0',
  ingestMode,
  rateLimit: Number(setting('API_RATE_LIMIT') ?? 10),
  burstLimit: Number(setting('API_BURST_LIMIT') ?? 20),
});

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pinecone } from '@pinecone-database/pinecone';

/**
 * Creates the Pinecone index this project expects, if it does not exist yet.
 *
 * Doing it in code rather than through the console keeps the setup
 * reproducible and keeps the index's shape in the repository: the dimension
 * has to match the embedding model, and that is a fact about the code, not a
 * value someone should have to remember to type into a form.
 *
 * Run with: npm run setup:pinecone
 */

const ENV_FILE = resolve(process.cwd(), '../../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const CLOUD = process.env['PINECONE_CLOUD'] ?? 'aws';
const REGION = process.env['PINECONE_REGION'] ?? 'us-east-1';
const METRIC = 'cosine';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    console.error(`Missing ${name}. Set it in .env at the repository root.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('PINECONE_API_KEY');
  const indexName = requireEnv('PINECONE_INDEX');
  const dimension = Number(process.env['EMBEDDING_DIMENSIONS'] ?? 1536);

  if (!Number.isInteger(dimension) || dimension <= 0) {
    console.error(`EMBEDDING_DIMENSIONS must be a positive integer, got "${dimension}".`);
    process.exit(1);
  }

  const pinecone = new Pinecone({ apiKey });

  const existing = await pinecone.listIndexes();
  const match = existing.indexes?.find((index) => index.name === indexName);

  if (match !== undefined) {
    console.log(`Index "${indexName}" already exists.`);
    console.log(`  dimension: ${match.dimension ?? 'unknown'}`);
    console.log(`  metric:    ${match.metric ?? 'unknown'}`);
    console.log(`  host:      ${match.host}`);

    // A dimension mismatch is silent until the first upsert fails, which is a
    // confusing place to discover it.
    if (match.dimension !== undefined && match.dimension !== dimension) {
      console.error(
        `\nMismatch: the index is ${match.dimension}-dimensional but EMBEDDING_DIMENSIONS is ${dimension}.`,
      );
      console.error('Either change EMBEDDING_DIMENSIONS, or delete and recreate the index.');
      process.exit(1);
    }
    if (match.metric !== undefined && match.metric !== METRIC) {
      console.error(`\nMismatch: the index uses "${match.metric}" but this project assumes "${METRIC}".`);
      process.exit(1);
    }

    console.log('\nReady.');
    return;
  }

  console.log(`Creating serverless index "${indexName}" (${dimension}d, ${METRIC}, ${CLOUD}/${REGION})…`);

  // The classic vector index, which is what the data-plane code in this
  // project uses (upsert / query / listPaginated by id prefix).
  await pinecone.createIndex({
    name: indexName,
    dimension,
    metric: METRIC,
    spec: { serverless: { cloud: CLOUD, region: REGION } },
    waitUntilReady: true,
    suppressConflicts: true,
  });

  const created = await pinecone.describeIndex(indexName);
  console.log('\nCreated and ready.');
  console.log(`  dimension: ${created.dimension ?? dimension}`);
  console.log(`  metric:    ${created.metric ?? METRIC}`);
  console.log(`  host:      ${created.host}`);
}

main().catch((error: unknown) => {
  console.error('\nFailed to prepare the Pinecone index.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

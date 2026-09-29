import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { buildContainer } from '../container.js';
import { answerQuestion } from '../core/ask.js';
import { ingestDocuments } from '../core/ingest.js';
import { NO_CONTEXT_ANSWER } from '../core/prompt.js';
import { silentLogger } from '../core/ports.js';

/**
 * A small answer-level evaluation harness.
 *
 * The unit tests prove the pipeline is wired correctly. They cannot prove the
 * prompt works, because the model is not in them. This runs a fixed set of
 * questions against real providers and checks two things per case: whether the
 * system answered or refused, and which documents it cited.
 *
 * It costs a few tenths of a cent to run and catches the failure the unit tests
 * structurally cannot: a prompt change that makes the model refuse questions it
 * should answer.
 *
 * Run with: npm run eval
 */

const ENV_FILE = resolve(process.cwd(), '../../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const NAMESPACE = 'eval';

const DOCUMENTS = [
  {
    id: 'refund-policy',
    title: 'Refund Policy',
    content:
      'Customers may request a full refund within 30 days of purchase, provided they present the original receipt. Refunds are issued to the original payment method within five business days. Digital goods, including software licences and downloadable content, are not eligible for refunds under any circumstances. Shipping fees are never refunded once an order has left the warehouse.',
  },
  {
    id: 'shipping-policy',
    title: 'Shipping Policy',
    content:
      'Standard shipping takes five to seven business days within the continental United States. Express shipping arrives in two business days for an additional fee of fifteen dollars. We do not ship to post office boxes. International orders may be subject to customs duties, which are the responsibility of the recipient.',
  },
  {
    id: 'warranty',
    title: 'Warranty Terms',
    content:
      'All hardware carries a limited warranty of twelve months from the date of delivery. The warranty covers manufacturing defects but excludes damage caused by misuse, liquid exposure, or unauthorised repair. Warranty claims require proof of purchase and must be filed through the support portal.',
  },
];

interface Case {
  question: string;
  /** Empty means the system is expected to refuse. */
  expectedSources: string[];
  why: string;
}

const CASES: Case[] = [
  {
    question: 'Can I get a refund on a digital product?',
    expectedSources: ['refund-policy'],
    why: 'paraphrase: the passage says "digital goods", the question says "digital product"',
  },
  {
    question: 'Can I get my money back on a downloaded game?',
    expectedSources: ['refund-policy'],
    why: 'heavier paraphrase: "money back" and "downloaded game"',
  },
  {
    question: 'Do you ship to a PO box?',
    expectedSources: ['shipping-policy'],
    why: 'abbreviation: the passage says "post office boxes"',
  },
  {
    question: 'How long is the hardware warranty?',
    expectedSources: ['warranty'],
    why: 'direct lookup, must not over-cite the other two documents',
  },
  {
    question: 'How much does express shipping cost?',
    expectedSources: ['shipping-policy'],
    why: 'direct lookup',
  },
  {
    question: 'Can I get a refund on a digital product, and how long is the hardware warranty?',
    expectedSources: ['refund-policy', 'warranty'],
    why: 'compound question spanning two documents, must cite both and only both',
  },
  {
    question: 'What is the CEO annual salary?',
    expectedSources: [],
    why: 'nothing in the corpus answers this; the system must refuse',
  },
  {
    question: 'What is the capital of France?',
    expectedSources: [],
    why: 'the model knows this, and must still refuse: it is not in the documents',
  },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, PINECONE_NAMESPACE: NAMESPACE });
  const { embeddings, completions, store } = buildContainer(config);

  console.log(`Seeding ${DOCUMENTS.length} documents into namespace "${NAMESPACE}"…`);
  await ingestDocuments({ embeddings, store, logger: silentLogger }, DOCUMENTS);
  await wait(6000);

  let passed = 0;
  const failures: string[] = [];

  for (const testCase of CASES) {
    const response = await answerQuestion(
      {
        embeddings,
        completions,
        store,
        logger: silentLogger,
        maxContextChars: config.guardrails.maxContextChars,
        maxOutputTokens: config.guardrails.maxOutputTokens,
      },
      { question: testCase.question, topK: 3 },
    );

    const refused = response.answer === NO_CONTEXT_ANSWER;
    const expectedRefusal = testCase.expectedSources.length === 0;
    const actual = response.sources.map((source) => source.docId).sort();
    const expected = [...testCase.expectedSources].sort();

    const problems: string[] = [];
    if (refused !== expectedRefusal) {
      problems.push(expectedRefusal ? 'answered but should have refused' : 'refused but should have answered');
    }
    if (actual.join(',') !== expected.join(',')) {
      problems.push(`cited [${actual.join(', ')}], expected [${expected.join(', ')}]`);
    }
    // A leaked JSON envelope in the user-visible answer is always a failure.
    if (response.answer.includes('"citations"')) {
      problems.push('the JSON envelope leaked into the answer text');
    }

    if (problems.length === 0) {
      passed += 1;
      console.log(`  PASS  ${testCase.question}`);
    } else {
      failures.push(`${testCase.question}\n          ${problems.join('\n          ')}`);
      console.log(`  FAIL  ${testCase.question}`);
      for (const problem of problems) console.log(`          ${problem}`);
      console.log(`          answer: ${response.answer}`);
      console.log(`          (${testCase.why})`);
    }
  }

  console.log(`\n${passed}/${CASES.length} cases passed.`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import type {
  CompletionProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingProvider,
  EmbeddingResult,
  VectorMatch,
  VectorRecord,
  VectorStore,
} from '../../src/core/ports.js';

/**
 * Deterministic stand-ins for the three external services.
 *
 * They are faithful to the port contracts rather than to OpenAI and Pinecone
 * specifically, which is the point of the ports: the core can be exercised
 * completely without a network or an API key.
 */

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

/** Bag-of-words hashing: texts sharing words land near each other, so cosine scores are meaningful. */
export function fakeEmbed(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const character of word) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    const slot = hash % dimensions;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return normalize(vector);
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'fake-embedding-model';
  /** One entry per embed() call, so tests can assert batching behaviour. */
  readonly calls: string[][] = [];

  constructor(readonly dimensions: number = 16) {}

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    this.calls.push([...texts]);
    return {
      vectors: texts.map((text) => fakeEmbed(text, this.dimensions)),
      usage: { promptTokens: texts.length, completionTokens: 0, totalTokens: texts.length },
    };
  }
}

/** Returns vectors of the wrong width, to exercise the dimension guard. */
export class MisconfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'wrong-dimensions';
  readonly dimensions = 16;

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map(() => new Array<number>(8).fill(0.1)),
      usage: undefined,
    };
  }
}

export class FakeCompletionProvider implements CompletionProvider {
  readonly model = 'fake-completion-model';
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly answer: string = 'A fake but grounded answer.') {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    return {
      text: this.answer,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    };
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (const [index, value] of a.entries()) {
    dot += value * (b[index] ?? 0);
  }
  return dot;
}

/** In-memory vector store with the same id-prefix semantics the Pinecone adapter relies on. */
export class FakeVectorStore implements VectorStore {
  readonly records = new Map<string, VectorRecord>();
  deleteCalls = 0;
  upsertCalls = 0;

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    this.upsertCalls += 1;
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  async query(vector: readonly number[], topK: number): Promise<VectorMatch[]> {
    return [...this.records.values()]
      .map((record) => ({
        id: record.id,
        score: cosine(vector, record.values),
        metadata: record.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async listIdsByDocId(docId: string): Promise<string[]> {
    const prefix = `${docId}#`;
    return [...this.records.keys()].filter((id) => id.startsWith(prefix)).sort();
  }

  async deleteByIds(ids: readonly string[]): Promise<void> {
    this.deleteCalls += 1;
    for (const id of ids) {
      this.records.delete(id);
    }
  }
}

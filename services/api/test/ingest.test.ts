import { describe, expect, it } from 'vitest';
import type { ChunkingOptions } from '../src/core/chunking.js';
import type { VectorRecord, VectorStore } from '../src/core/ports.js';
import { UpstreamError } from '../src/core/errors.js';
import { ingestDocuments } from '../src/core/ingest.js';
import {
  FakeEmbeddingProvider,
  FakeVectorStore,
  MisconfiguredEmbeddingProvider,
} from './support/fakes.js';

const chunking: ChunkingOptions = { maxChunkChars: 60, overlapChars: 10, maxChunksPerDocument: 50 };

const LONG_POLICY = [
  'Full refund within 30 days with receipt.',
  'No refunds on digital goods.',
  'Shipping fees are never refunded.',
  'Exchanges are handled by the original store.',
].join(' ');

const SHORT_POLICY = 'No refunds on digital goods.';

function deps(store: FakeVectorStore, embeddings = new FakeEmbeddingProvider()) {
  return { embeddings, store, chunking };
}

describe('ingestDocuments', () => {
  it('stores one vector per chunk and reports the counts', async () => {
    const store = new FakeVectorStore();

    const result = await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY },
    ]);

    expect(result.ingestedDocuments).toBe(1);
    expect(result.ingestedChunks).toBeGreaterThan(1);
    expect(store.records.size).toBe(result.ingestedChunks);
  });

  it('namespaces vector ids by document so two documents never collide', async () => {
    const store = new FakeVectorStore();

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: SHORT_POLICY },
      { id: 'shipping', title: 'Shipping Policy', content: SHORT_POLICY },
    ]);

    expect(await store.listIdsByDocId('refund-policy')).toEqual(['refund-policy#chunk-1']);
    expect(await store.listIdsByDocId('shipping')).toEqual(['shipping#chunk-1']);
  });

  it('attaches the metadata the /ask response is built from', async () => {
    const store = new FakeVectorStore();

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: SHORT_POLICY },
    ]);

    expect(store.records.get('refund-policy#chunk-1')?.metadata).toEqual({
      docId: 'refund-policy',
      title: 'Refund Policy',
      chunkText: SHORT_POLICY,
      chunkIndex: 0,
    });
  });

  it('updates in place when the same id is ingested again, rather than duplicating', async () => {
    const store = new FakeVectorStore();
    const document = { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY };

    const first = await ingestDocuments(deps(store), [document]);
    const sizeAfterFirst = store.records.size;
    const second = await ingestDocuments(deps(store), [document]);

    expect(second.ingestedChunks).toBe(first.ingestedChunks);
    expect(store.records.size).toBe(sizeAfterFirst);
  });

  it('picks up edits to a document without leaving the old text behind', async () => {
    const store = new FakeVectorStore();

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: 'Refunds take 30 days.' },
    ]);
    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: 'Refunds take 14 days.' },
    ]);

    const stored = [...store.records.values()].map((record) => record.metadata.chunkText);
    expect(stored).toEqual(['Refunds take 14 days.']);
  });

  it('deletes the trailing chunks when a document is replaced by a shorter one', async () => {
    const store = new FakeVectorStore();

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY },
    ]);
    const idsBefore = await store.listIdsByDocId('refund-policy');
    expect(idsBefore.length).toBeGreaterThan(1);

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: SHORT_POLICY },
    ]);

    expect(await store.listIdsByDocId('refund-policy')).toEqual(['refund-policy#chunk-1']);
    expect(store.deleteCalls).toBe(1);
  });

  it('leaves other documents untouched when one is re-ingested', async () => {
    const store = new FakeVectorStore();

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY },
      { id: 'shipping', title: 'Shipping Policy', content: SHORT_POLICY },
    ]);
    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: SHORT_POLICY },
    ]);

    expect(await store.listIdsByDocId('shipping')).toEqual(['shipping#chunk-1']);
  });

  it('reports how many documents replaced one already in the store', async () => {
    const store = new FakeVectorStore();
    const first = { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY };
    const second = { id: 'shipping', title: 'Shipping Policy', content: SHORT_POLICY };

    const initial = await ingestDocuments(deps(store), [first]);
    expect(initial.replacedDocuments).toBe(0);

    // Replacing destroys the previous version, so it is counted rather than
    // reported as the same success as a first write.
    const again = await ingestDocuments(deps(store), [first, second]);
    expect(again.ingestedDocuments).toBe(2);
    expect(again.replacedDocuments).toBe(1);
  });

  it('does not delete anything when a document is ingested for the first time', async () => {
    const store = new FakeVectorStore();

    await ingestDocuments(deps(store), [
      { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY },
    ]);

    expect(store.deleteCalls).toBe(0);
  });

  it('embeds chunks in batches instead of one request per chunk', async () => {
    const store = new FakeVectorStore();
    const embeddings = new FakeEmbeddingProvider();

    const result = await ingestDocuments(
      { embeddings, store, chunking, embeddingBatchSize: 96 },
      [{ id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY }],
    );

    expect(result.ingestedChunks).toBeGreaterThan(1);
    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0]).toHaveLength(result.ingestedChunks);
  });

  it('splits embedding calls once a document exceeds the batch size', async () => {
    const store = new FakeVectorStore();
    const embeddings = new FakeEmbeddingProvider();

    await ingestDocuments({ embeddings, store, chunking, embeddingBatchSize: 2 }, [
      { id: 'refund-policy', title: 'Refund Policy', content: LONG_POLICY },
    ]);

    expect(embeddings.calls.length).toBeGreaterThan(1);
    for (const call of embeddings.calls) {
      expect(call.length).toBeLessThanOrEqual(2);
    }
  });

  it('fails loudly when the embedding model does not match the index dimension', async () => {
    const store = new FakeVectorStore();

    await expect(
      ingestDocuments({ embeddings: new MisconfiguredEmbeddingProvider(), store, chunking }, [
        { id: 'refund-policy', title: 'Refund Policy', content: SHORT_POLICY },
      ]),
    ).rejects.toThrow(UpstreamError);
  });
});

describe('ingestDocuments under a concurrent writer', () => {
  /**
   * Characterisation test for a known limitation, not a wish.
   *
   * list -> upsert -> delete is not atomic. With two writers on the same
   * document id these steps can interleave so that one deletes chunks the other
   * has just written, leaving a version nobody submitted. The interleaving is
   * forced here rather than raced for, so this fails the same way every run
   * instead of once every few.
   *
   * The supported fix is the FIFO queue in async mode, where MessageGroupId is
   * the document id and SQS serialises writes per document. The synchronous
   * path cannot fix it without a lock the vector store does not offer, so the
   * boundary of the guarantee is pinned here and stated in the README.
   */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it('can leave a version that was never submitted when two writers overlap', async () => {
    const store = new FakeVectorStore();
    const embeddings = new FakeEmbeddingProvider();

    const shortUpserted = gate();
    const longUpserted = gate();
    const shortHasListed = gate();

    /** Wraps the store so each writer's steps can be placed exactly. */
    function forWriter(writer: 'short' | 'long'): VectorStore {
      return {
        async upsert(records: readonly VectorRecord[]) {
          await store.upsert(records);
          if (writer === 'short') {
            shortUpserted.open();
            await longUpserted.promise;
          } else {
            longUpserted.open();
          }
        },
        query: (vector, topK) => store.query(vector, topK),
        async listIdsByDocId(docId: string) {
          if (writer === 'long') await shortUpserted.promise;
          const ids = await store.listIdsByDocId(docId);
          if (writer === 'short') shortHasListed.open();
          return ids;
        },
        deleteByIds: (ids) => store.deleteByIds(ids),
      };
    }

    const LONG = [
      'Alpha one sentence here.',
      'Bravo two sentence here.',
      'Charlie three sentence here.',
      'Delta four sentence here.',
    ].join(' ');
    const SHORT = 'Alpha one sentence here.';

    await ingestDocuments({ embeddings, store, chunking }, [
      { id: 'doc', title: 'D', content: LONG },
    ]);
    const before = await store.listIdsByDocId('doc');
    expect(before.length).toBeGreaterThan(1);

    await Promise.all([
      ingestDocuments({ embeddings, store: forWriter('short'), chunking }, [
        { id: 'doc', title: 'D', content: SHORT },
      ]),
      (async () => {
        await shortHasListed.promise;
        return ingestDocuments({ embeddings, store: forWriter('long'), chunking }, [
          { id: 'doc', title: 'D', content: LONG },
        ]);
      })(),
    ]);

    const after = await store.listIdsByDocId('doc');
    const stored = after.map((id) => store.records.get(id)!.metadata.chunkText);

    const isShortVersion = stored.length === 1 && stored[0] === SHORT;
    const isLongVersion = stored.length === before.length;

    // Neither writer won cleanly: the surviving chunks carry the long version's
    // text but only the short version's count.
    expect(isShortVersion || isLongVersion).toBe(false);
    expect(stored[0]).not.toBe(SHORT);
    expect(after.length).toBeLessThan(before.length);
  });
});

import type { SQSBatchResponse, SQSEvent, SQSHandler } from 'aws-lambda';
import { fetchStagedDocument, parseIngestJobMessage } from '../adapters/ingestQueue.js';
import { getContainer } from '../container.js';
import { describeError } from '../core/errors.js';
import { ingestDocuments } from '../core/ingest.js';

/**
 * SQS-triggered worker for async ingest.
 *
 * It runs the same `ingestDocuments` the synchronous endpoint runs — the async
 * path changes when the work happens, not what the work is. That reuse is the
 * payoff for keeping the pipeline free of transport concerns.
 *
 * Failures are reported per message via `batchItemFailures`, so one poisoned
 * document does not force SQS to redeliver the whole batch and re-embed
 * documents that already succeeded.
 */
export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const { embeddings, store, logger } = getContainer();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = parseIngestJobMessage(record.body);
      const document = await fetchStagedDocument(message);

      const result = await ingestDocuments({ embeddings, store, logger }, [document]);

      logger.info('Worker ingested a queued document.', {
        jobId: message.jobId,
        docId: message.docId,
        chunks: result.ingestedChunks,
      });
    } catch (error) {
      logger.error('Worker failed to ingest a queued document.', {
        messageId: record.messageId,
        reason: describeError(error),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

import type { SQSBatchResponse, SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import { fetchStagedDocument, parseIngestJobMessage } from '../adapters/ingestQueue.js';
import { createJsonLogger } from '../adapters/logger.js';
import { getContainer } from '../container.js';
import { describeError } from '../core/errors.js';
import { ingestDocuments } from '../core/ingest.js';

/**
 * SQS-triggered worker for async ingest.
 *
 * It runs the same `ingestDocuments` the synchronous endpoint runs — the async
 * path changes when the work happens, not what the work is. That reuse is the
 * payoff for keeping the pipeline free of transport concerns.
 */

/**
 * Messages of one document share a group id, and the queue is FIFO so that
 * writes to a document stay ordered.
 *
 * Reporting only the individually failed message would break exactly the
 * guarantee the FIFO queue exists to provide: if v1 fails transiently and v2
 * succeeds, SQS redelivers v1 alone and it lands after v2, leaving the index on
 * the older version. So once a group fails, every later message of that group
 * is reported as failed too and left unprocessed, and the whole group is
 * retried in order.
 */
function groupOf(record: SQSRecord): string {
  return record.attributes.MessageGroupId ?? record.messageId;
}

export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const logger = createJsonLogger({ service: 'doc-qa', handler: 'ingestWorker' });
  const { embeddings, store } = getContainer();

  const batchItemFailures: { itemIdentifier: string }[] = [];
  const failedGroups = new Set<string>();

  for (const record of event.Records) {
    const group = groupOf(record);

    if (failedGroups.has(group)) {
      logger.warn('Skipping a message behind a failure in its own group.', {
        messageId: record.messageId,
        messageGroupId: group,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

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
        messageGroupId: group,
        reason: describeError(error),
      });
      failedGroups.add(group);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

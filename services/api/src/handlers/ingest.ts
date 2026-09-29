import { randomUUID } from 'node:crypto';
import type { IngestResponse } from '@docqa/contracts';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { enqueueDocument } from '../adapters/ingestQueue.js';
import { createJsonLogger } from '../adapters/logger.js';
import { getContainer } from '../container.js';
import { ConfigurationError } from '../core/errors.js';
import { ingestDocuments } from '../core/ingest.js';
import { parseIngestRequest } from '../core/validation.js';
import { errorResponse, jsonResponse, parseJsonBody } from '../http.js';

/**
 * POST /ingest
 *
 * Synchronous by default. With INGEST_MODE=async the request is accepted, the
 * documents are staged to S3 and queued, and a worker Lambda does the chunking
 * and embedding — see handlers/ingestWorker.ts.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const logger = createJsonLogger({ service: 'doc-qa', handler: 'ingest' });

  try {
    const { config, embeddings, store } = getContainer();
    const documents = parseIngestRequest(parseJsonBody(event));

    if (config.ingest.mode === 'async') {
      const { bucket, queueUrl } = config.ingest;
      if (bucket === undefined || queueUrl === undefined) {
        // loadConfig already enforces this; the check keeps the types honest.
        throw new ConfigurationError('Async ingest is enabled without a bucket or queue URL.');
      }

      const jobId = randomUUID();
      for (const document of documents) {
        await enqueueDocument(document, { jobId, bucket, queueUrl });
      }

      logger.info('Queued documents for async ingest.', { jobId, documents: documents.length });

      const queued: IngestResponse = {
        status: 'queued',
        ingestedDocuments: documents.length,
        ingestedChunks: null,
        jobId,
      };
      return jsonResponse(202, queued);
    }

    const result = await ingestDocuments({ embeddings, store, logger }, documents);

    const completed: IngestResponse = { status: 'completed', ...result };
    return jsonResponse(200, completed);
  } catch (error) {
    return errorResponse(error, logger);
  }
};

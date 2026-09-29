import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createJsonLogger } from '../adapters/logger.js';
import { getContainer } from '../container.js';
import { answerQuestion } from '../core/ask.js';
import { parseAskRequest } from '../core/validation.js';
import { errorResponse, jsonResponse, parseJsonBody } from '../http.js';

/**
 * POST /ask
 *
 * Retrieval and grounding live in the core; this handler only translates
 * between HTTP and that call.
 *
 * The logger is built before anything else and does not depend on
 * configuration, so a misconfigured deployment still reports *why* it is
 * misconfigured instead of failing anonymously.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const logger = createJsonLogger({ service: 'doc-qa', handler: 'ask' });

  try {
    const { config, embeddings, completions, store } = getContainer();
    const { question, topK } = parseAskRequest(parseJsonBody(event));

    const response = await answerQuestion(
      {
        embeddings,
        completions,
        store,
        logger,
        maxContextChars: config.guardrails.maxContextChars,
        maxOutputTokens: config.guardrails.maxOutputTokens,
        minScore: config.guardrails.minScore,
      },
      { question, topK },
    );

    return jsonResponse(200, response);
  } catch (error) {
    return errorResponse(error, logger);
  }
};

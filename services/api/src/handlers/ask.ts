import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getContainer } from '../container.js';
import { answerQuestion } from '../core/ask.js';
import { parseAskRequest } from '../core/validation.js';
import { errorResponse, jsonResponse, parseJsonBody } from '../http.js';

/**
 * POST /ask
 *
 * Retrieval and grounding live in the core; this handler only translates
 * between HTTP and that call.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const { config, embeddings, completions, store, logger } = getContainer();

  try {
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

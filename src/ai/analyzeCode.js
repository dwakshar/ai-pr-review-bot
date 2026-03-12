/**
 * analyzeCode.js — Sends code diffs to OpenAI and parses structured review feedback.
 *
 * Design decisions:
 * - We use p-retry for exponential backoff on transient failures (rate limits,
 *   network errors). This is critical for reliability in CI environments where
 *   retrying is cheap but failures are disruptive.
 * - response_format: { type: 'json_object' } is NOT used here because we ask for
 *   a JSON array (not object). Instead we parse and validate the response ourselves,
 *   which also gives us graceful handling of malformed output.
 * - Each file is analyzed independently to keep prompts focused and avoid
 *   cross-contamination of context. Multi-file analysis is opt-in for related files.
 * - The OpenAI client is instantiated once and shared to reuse the connection pool.
 */

import OpenAI from 'openai';
import pRetry from 'p-retry';
import { SYSTEM_PROMPT, buildFileReviewPrompt } from './promptTemplates.js';
import { estimateTokens, truncateToTokenLimit } from '../utils/tokenManager.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('analyzeCode');

// Singleton client — instantiated once per process lifecycle
let openaiClient = null;

function getClient() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Analyzes a single file's diff and returns structured review comments.
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {string} params.diffContent
 * @param {string} [params.guidelines]
 * @param {string} [params.prTitle]
 * @param {object} params.aiConfig - config.ai
 * @returns {Promise<Array<AIComment>>}
 */
export async function analyzeFileDiff({
  filePath,
  diffContent,
  guidelines,
  prTitle,
  aiConfig = {}
}) {
  const {
    model = 'gpt-4o',
    temperature = 0.2,
    maxTokensPerRequest = 4096,
    maxTokensPerFile = 2000
  } = aiConfig;

  // Truncate diff if it exceeds per-file token limit to control cost
  const truncatedDiff = truncateToTokenLimit(diffContent, maxTokensPerFile);
  const userPrompt = buildFileReviewPrompt({
    filePath,
    diffContent: truncatedDiff,
    guidelines,
    prTitle
  });

  const estimatedInput = estimateTokens(SYSTEM_PROMPT) + estimateTokens(userPrompt);
  log.debug('Sending file for analysis', {
    file: filePath,
    estimatedInputTokens: estimatedInput
  });

  // Wrap in p-retry for resilience against transient OpenAI errors
  const rawResponse = await pRetry(
    () => callOpenAI({
      model,
      temperature,
      maxTokens: maxTokensPerRequest,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt
    }),
    {
      retries: 3,
      minTimeout: 1000,
      factor: 2,
      onFailedAttempt: (error) => {
        log.warn('OpenAI request failed, retrying', {
          attempt: error.attemptNumber,
          error: error.message,
          file: filePath
        });
      }
    }
  );

  return parseAIResponse(rawResponse, filePath);
}

/**
 * Makes the actual OpenAI chat completion request.
 * Separated from retry logic to keep concerns clean.
 */
async function callOpenAI({ model, temperature, maxTokens, systemPrompt, userPrompt }) {
  const client = getClient();

  const response = await client.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned an empty response');
  }

  log.debug('OpenAI response received', {
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens
  });

  return content;
}

/**
 * Parses and validates the JSON array returned by OpenAI.
 * Returns an empty array on invalid output rather than throwing,
 * so a bad AI response doesn't break the entire review pipeline.
 *
 * @param {string} rawContent
 * @param {string} filePath
 * @returns {Array<AIComment>}
 */
function parseAIResponse(rawContent, filePath) {
  let parsed;

  try {
    // Strip potential markdown fences the model might add despite instructions
    const cleaned = rawContent
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();

    parsed = JSON.parse(cleaned);
  } catch (err) {
    log.warn('Failed to parse AI response as JSON', {
      file: filePath,
      error: err.message,
      rawSnippet: rawContent.slice(0, 200)
    });
    return [];
  }

  if (!Array.isArray(parsed)) {
    log.warn('AI response was not an array', { file: filePath });
    return [];
  }

  // Validate and normalize each comment, dropping malformed entries
  const valid = parsed
    .filter(item => {
      const isValid =
        typeof item.line === 'number' &&
        typeof item.title === 'string' &&
        ['info', 'suggestion', 'warning', 'error'].includes(item.severity);
      if (!isValid) {
        log.debug('Dropping invalid AI comment', { item });
      }
      return isValid;
    })
    .map(item => ({
      path: filePath,
      line: item.line,
      severity: item.severity,
      title: item.title.trim(),
      body: item.body?.trim() ?? '',
      suggestion: item.suggestion ?? null
    }));

  log.info(`AI analysis complete`, {
    file: filePath,
    commentsFound: valid.length
  });

  return valid;
}

/**
 * @typedef {Object} AIComment
 * @property {string} path
 * @property {number} line
 * @property {'info'|'suggestion'|'warning'|'error'} severity
 * @property {string} title
 * @property {string} body
 * @property {string|null} suggestion
 */

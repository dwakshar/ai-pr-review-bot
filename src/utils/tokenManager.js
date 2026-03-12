/**
 * tokenManager.js — Token budget tracking and text truncation utilities.
 *
 * Design decisions:
 * - We use a conservative character-to-token approximation (÷4) rather than
 *   importing a full tokenizer library. This avoids a large dependency while
 *   remaining accurate enough for budget enforcement. Real tokenization can be
 *   plugged in by replacing estimateTokens().
 * - The TokenBudget class provides per-run accounting so callers can make
 *   informed decisions about which files to include or skip.
 */

import { createContextLogger } from './logger.js';

const log = createContextLogger('tokenManager');

// Conservative approximation: ~4 chars per token for English/code text.
const CHARS_PER_TOKEN = 4;

/**
 * Estimates the token count of a string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncates text to fit within a token budget, appending a notice if cut.
 * Truncation happens at line boundaries to avoid splitting mid-statement.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
export function truncateToTokenLimit(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const lines = text.split('\n');
  const result = [];
  let charCount = 0;

  for (const line of lines) {
    if (charCount + line.length + 1 > maxChars) break;
    result.push(line);
    charCount += line.length + 1;
  }

  result.push('... [truncated to fit token limit]');
  log.debug(`Truncated content from ${text.length} to ${charCount} chars`);
  return result.join('\n');
}

/**
 * Manages a running token budget across multiple API calls in a single run.
 * Allows the orchestrator to skip files when the budget is exhausted.
 */
export class TokenBudget {
  constructor(totalBudget) {
    this.totalBudget = totalBudget;
    this.used = 0;
  }

  get remaining() {
    return this.totalBudget - this.used;
  }

  get isExhausted() {
    return this.used >= this.totalBudget;
  }

  /**
   * Attempts to allocate tokens. Returns true if allocation succeeded.
   * @param {number} tokens
   * @returns {boolean}
   */
  allocate(tokens) {
    if (tokens > this.remaining) {
      log.warn('Token budget insufficient', {
        requested: tokens,
        remaining: this.remaining
      });
      return false;
    }
    this.used += tokens;
    log.debug('Token allocation', {
      allocated: tokens,
      used: this.used,
      remaining: this.remaining
    });
    return true;
  }

  summary() {
    return {
      total: this.totalBudget,
      used: this.used,
      remaining: this.remaining,
      utilizationPct: Math.round((this.used / this.totalBudget) * 100)
    };
  }
}

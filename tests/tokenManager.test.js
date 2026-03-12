/**
 * tokenManager.test.js — Unit tests for token estimation and budget management.
 */

import { estimateTokens, truncateToTokenLimit, TokenBudget } from '../src/utils/tokenManager.js';

describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  test('estimates tokens using 4-char approximation', () => {
    const text = 'a'.repeat(400);  // 400 chars → 100 tokens
    expect(estimateTokens(text)).toBe(100);
  });

  test('rounds up fractional tokens', () => {
    expect(estimateTokens('abc')).toBe(1);  // 3 chars → ceil(0.75) = 1
  });
});

describe('truncateToTokenLimit', () => {
  test('returns original text if within limit', () => {
    const text = 'short text';
    expect(truncateToTokenLimit(text, 100)).toBe(text);
  });

  test('truncates text to token limit with notice', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const result = truncateToTokenLimit(text, 50);  // ~200 chars limit

    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('[truncated to fit token limit]');
  });

  test('truncates at line boundaries', () => {
    const text = 'line one\nline two\nline three\n' + 'x'.repeat(1000);
    const result = truncateToTokenLimit(text, 5);
    expect(result.split('\n').every(l => l.length > 0 || l.includes('truncated'))).toBe(true);
  });
});

describe('TokenBudget', () => {
  test('initializes with correct budget', () => {
    const budget = new TokenBudget(1000);
    expect(budget.remaining).toBe(1000);
    expect(budget.isExhausted).toBe(false);
  });

  test('allocates tokens successfully when budget available', () => {
    const budget = new TokenBudget(1000);
    const success = budget.allocate(500);
    expect(success).toBe(true);
    expect(budget.used).toBe(500);
    expect(budget.remaining).toBe(500);
  });

  test('refuses allocation when budget insufficient', () => {
    const budget = new TokenBudget(100);
    const success = budget.allocate(200);
    expect(success).toBe(false);
    expect(budget.used).toBe(0);
  });

  test('marks as exhausted when fully consumed', () => {
    const budget = new TokenBudget(100);
    budget.allocate(100);
    expect(budget.isExhausted).toBe(true);
  });

  test('summary returns correct utilization percentage', () => {
    const budget = new TokenBudget(1000);
    budget.allocate(250);
    const summary = budget.summary();
    expect(summary.utilizationPct).toBe(25);
    expect(summary.used).toBe(250);
    expect(summary.remaining).toBe(750);
  });
});

/**
 * ruleFilter.test.js — Unit tests for the rule-based comment filter.
 */

import { shouldSkipFile, filterComments, isLineInDiff } from '../src/engine/ruleFilter.js';

// Minimal parsed file fixture
const makeFile = (path, additions = 10, deletions = 5, changedLines = []) => ({
  path,
  additions,
  deletions,
  changedLines: changedLines.length > 0
    ? changedLines
    : Array.from({ length: additions }, (_, i) => ({
        lineNumber: i + 1,
        type: 'add',
        content: `+line ${i + 1}`
      }))
});

const makeComment = (overrides = {}) => ({
  path: 'src/index.js',
  line: 5,
  severity: 'suggestion',
  title: 'Consider using const instead of let here',
  body: 'This variable is never reassigned.',
  suggestion: null,
  ...overrides
});

describe('shouldSkipFile', () => {
  const config = { review: { minChangedLinesForReview: 5 } };

  test('skips files with too few changes', () => {
    const file = makeFile('src/tiny.js', 2, 1);
    const result = shouldSkipFile(file, config);
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/changed lines/);
  });

  test('allows files with sufficient changes', () => {
    const file = makeFile('src/main.js', 10, 5);
    const result = shouldSkipFile(file, config);
    expect(result.skip).toBe(false);
  });

  test('skips snapshot files', () => {
    const file = makeFile('src/__snapshots__/App.test.js.snap', 20, 0);
    const result = shouldSkipFile(file, config);
    expect(result.skip).toBe(true);
  });

  test('skips migration files', () => {
    const file = makeFile('db/migrations/1699999999_add_users.js', 50, 0);
    const result = shouldSkipFile(file, config);
    expect(result.skip).toBe(true);
  });

  test('skips fixture directories', () => {
    const file = makeFile('tests/fixtures/response.json', 20, 0);
    const result = shouldSkipFile(file, config);
    expect(result.skip).toBe(true);
  });
});

describe('filterComments', () => {
  const config = {
    filters: { severityThreshold: 'info', ignoreCategories: ['whitespace'] },
    review: { maxCommentsPerReview: 15 }
  };

  test('passes valid comments through', () => {
    const comments = [makeComment()];
    const result = filterComments(comments, 'src/index.js', config);
    expect(result).toHaveLength(1);
  });

  test('drops comments below severity threshold', () => {
    const config = {
      filters: { severityThreshold: 'warning' },
      review: { maxCommentsPerReview: 15 }
    };
    const comments = [
      makeComment({ severity: 'error' }),
      makeComment({ severity: 'warning' }),
      makeComment({ severity: 'suggestion' }),  // below threshold
      makeComment({ severity: 'info' })          // below threshold
    ];
    const result = filterComments(comments, 'src/index.js', config);
    expect(result).toHaveLength(2);
    expect(result.every(c => ['error', 'warning'].includes(c.severity))).toBe(true);
  });

  test('filters comments matching ignored categories', () => {
    const comments = [
      makeComment({ title: 'Fix whitespace indentation issue' }),
      makeComment({ title: 'Potential null pointer dereference' })
    ];
    const result = filterComments(comments, 'src/index.js', config);
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain('null pointer');
  });

  test('drops comments with too-short titles', () => {
    const comments = [makeComment({ title: 'Bad' })];
    const result = filterComments(comments, 'src/index.js', config);
    expect(result).toHaveLength(0);
  });

  test('caps high comment density and sorts by severity', () => {
    const config = { filters: {}, review: { maxCommentsPerReview: 3 } };
    const comments = Array.from({ length: 15 }, (_, i) => makeComment({
      severity: i < 5 ? 'info' : i < 10 ? 'suggestion' : 'warning',
      title: `Issue number ${i} that is quite descriptive`
    }));
    const result = filterComments(comments, 'src/index.js', config);
    expect(result.length).toBeLessThanOrEqual(3);
    // Should keep highest severity first
    expect(result[0].severity).toBe('warning');
  });
});

describe('isLineInDiff', () => {
  test('returns true for lines in diff', () => {
    const file = makeFile('src/index.js', 5, 0, [
      { lineNumber: 10, type: 'add', content: '+new line' },
      { lineNumber: 15, type: 'add', content: '+another line' }
    ]);
    const comment = makeComment({ line: 10 });
    expect(isLineInDiff(comment, file)).toBe(true);
  });

  test('returns false for lines not in diff', () => {
    const file = makeFile('src/index.js', 5, 0, [
      { lineNumber: 10, type: 'add', content: '+new line' }
    ]);
    const comment = makeComment({ line: 99 });
    expect(isLineInDiff(comment, file)).toBe(false);
  });

  test('returns false for deleted lines (we only comment on additions)', () => {
    const file = makeFile('src/index.js', 0, 5, [
      { lineNumber: 10, type: 'del', content: '-old line' }
    ]);
    const comment = makeComment({ line: 10 });
    expect(isLineInDiff(comment, file)).toBe(false);
  });
});

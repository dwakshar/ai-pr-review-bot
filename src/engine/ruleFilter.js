/**
 * ruleFilter.js — Pre-filters files and post-filters AI comments using rule-based heuristics.
 *
 * Design decisions:
 * - Two-stage filtering: pre-analysis (skip files not worth reviewing) and
 *   post-analysis (drop low-quality or irrelevant AI outputs).
 * - Rule-based filtering is intentionally separate from AI analysis. It runs
 *   cheaply without API calls and catches obvious cases (test files, generated
 *   code, trivial diffs) before spending tokens.
 * - Severity threshold filtering allows teams to tune signal level. A team
 *   wanting only warnings/errors can set threshold to 'warning'.
 * - Comment density guard prevents spam on large files — if the AI returns
 *   an implausibly large number of comments, we cap and sort by severity.
 */

import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('ruleFilter');

const SEVERITY_ORDER = { error: 0, warning: 1, suggestion: 2, info: 3 };

/**
 * Determines if a file should be sent for AI analysis.
 * This is a cheap pre-filter to avoid unnecessary API calls.
 *
 * @param {object} parsedFile - Output from parsePRDiff
 * @param {object} config
 * @returns {{ skip: boolean, reason?: string }}
 */
export function shouldSkipFile(parsedFile, config = {}) {
  const { minChangedLinesForReview = 5, maxFilesPerReview = 20 } = config.review ?? {};

  // Skip files with too few changes — not worth the API cost
  const totalChanged = parsedFile.additions + parsedFile.deletions;
  if (totalChanged < minChangedLinesForReview) {
    return {
      skip: true,
      reason: `Only ${totalChanged} changed lines (minimum: ${minChangedLinesForReview})`
    };
  }

  // Skip test snapshots — they're auto-generated and shouldn't be reviewed
  if (parsedFile.path.includes('__snapshots__') || parsedFile.path.endsWith('.snap')) {
    return { skip: true, reason: 'Jest snapshot file' };
  }

  // Skip migration files — they're usually auto-generated schema changes
  if (/\d{13,}_/.test(parsedFile.path) || parsedFile.path.includes('/migrations/')) {
    return { skip: true, reason: 'Database migration file' };
  }

  // Skip fixture/mock data files
  if (/\/(fixtures?|mocks?|stubs?|fakes?)\//.test(parsedFile.path)) {
    return { skip: true, reason: 'Test fixture or mock file' };
  }

  return { skip: false };
}

/**
 * Post-processes AI comments to remove noise and enforce quality gates.
 *
 * @param {Array<AIComment>} comments
 * @param {string} filePath
 * @param {object} config
 * @returns {Array<AIComment>}
 */
export function filterComments(comments, filePath, config = {}) {
  const {
    severityThreshold = 'info',
    ignoreCategories = []
  } = config.filters ?? {};

  const { maxCommentsPerReview = 15 } = config.review ?? {};
  const thresholdLevel = SEVERITY_ORDER[severityThreshold] ?? 3;

  let filtered = comments;

  // Apply severity threshold
  filtered = filtered.filter(comment => {
    const level = SEVERITY_ORDER[comment.severity] ?? 3;
    return level <= thresholdLevel;
  });

  // Filter ignored categories (basic keyword matching)
  if (ignoreCategories.length > 0) {
    filtered = filtered.filter(comment => {
      const text = (comment.title + comment.body).toLowerCase();
      const matchesIgnored = ignoreCategories.some(cat =>
        text.includes(cat.toLowerCase())
      );
      if (matchesIgnored) {
        log.debug('Filtered comment by category', { title: comment.title });
      }
      return !matchesIgnored;
    });
  }

  // Guard against implausible comment density (AI hallucination signal)
  // If >10 comments on a file, sort by severity and take the most important
  const MAX_PER_FILE = Math.min(maxCommentsPerReview, 10);
  if (filtered.length > MAX_PER_FILE) {
    log.warn(`High comment density on ${filePath}, capping to ${MAX_PER_FILE}`, {
      original: filtered.length
    });
    filtered = filtered
      .sort((a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
      )
      .slice(0, MAX_PER_FILE);
  }

  // Drop comments with suspiciously short titles (likely garbage output)
  filtered = filtered.filter(comment => {
    if (comment.title.length < 10) {
      log.debug('Dropping comment with too-short title', { title: comment.title });
      return false;
    }
    return true;
  });

  log.debug(`Comment filter: ${comments.length} → ${filtered.length}`, { file: filePath });
  return filtered;
}

/**
 * Validates that a comment's line number falls within the changed lines of the file.
 * Prevents the AI from hallucinating line numbers that weren't in the diff.
 *
 * @param {AIComment} comment
 * @param {object} parsedFile
 * @returns {boolean}
 */
export function isLineInDiff(comment, parsedFile) {
  const changedLineNumbers = new Set(
    parsedFile.changedLines
      .filter(l => l.type === 'add')
      .map(l => l.lineNumber)
  );

  const inDiff = changedLineNumbers.has(comment.line);
  if (!inDiff) {
    log.debug('Dropping comment for line not in diff', {
      file: comment.path,
      line: comment.line
    });
  }
  return inDiff;
}

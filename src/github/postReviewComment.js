/**
 * postReviewComment.js — Posts inline and summary review comments to GitHub PRs.
 *
 * Design decisions:
 * - We use the "pull request review" API (createReview + submitReview) rather
 *   than posting individual comments. This batches all comments into a single
 *   review event, which is far less noisy than N separate comment notifications.
 * - Deduplication is performed by hashing (file + line + comment body) against
 *   existing review comments fetched before posting. This prevents the bot from
 *   re-commenting the same issue on every PR synchronize event.
 * - Comment severity levels are prepended as emoji labels so reviewers can
 *   quickly triage bot feedback without reading the full comment.
 */

import crypto from 'crypto';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('postReviewComment');

/** Maps severity levels to visual labels prepended to comments */
const SEVERITY_LABELS = {
  info:       '💡 **Info:**',
  suggestion: '📝 **Suggestion:**',
  warning:    '⚠️ **Warning:**',
  error:      '🚨 **Error:**'
};

/**
 * Fetches all existing review comments on the PR to enable deduplication.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner, repo, pull_number }} params
 * @returns {Promise<Set<string>>} Set of content hashes for existing comments
 */
export async function fetchExistingCommentHashes(octokit, { owner, repo, pull_number }) {
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    { owner, repo, pull_number, per_page: 100 }
  );

  const hashes = new Set(
    comments
      .filter(c => c.user?.type === 'Bot')  // Only consider our own bot comments
      .map(c => hashComment(c.path, c.position ?? c.line, c.body))
  );

  log.debug(`Fetched ${comments.length} existing comments, ${hashes.size} from bot`);
  return hashes;
}

/**
 * Creates a deterministic hash for deduplication.
 */
function hashComment(path, line, body) {
  return crypto
    .createHash('sha1')
    .update(`${path}:${line}:${body}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Formats a review comment with severity label and structured body.
 *
 * @param {ReviewComment} comment
 * @returns {string} Formatted markdown body
 */
function formatCommentBody(comment) {
  const label = SEVERITY_LABELS[comment.severity] ?? SEVERITY_LABELS.suggestion;
  const parts = [`${label} ${comment.title}`];

  if (comment.body) {
    parts.push('', comment.body);
  }

  if (comment.suggestion) {
    parts.push('', '**Suggested fix:**', '```suggestion', comment.suggestion, '```');
  }

  // Bot attribution footer for transparency
  parts.push('', '---', '*Posted by AI PR Review Bot*');
  return parts.join('\n');
}

/**
 * Posts a batched pull request review with inline comments.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.pull_number
 * @param {string} params.commitSha
 * @param {ReviewComment[]} params.comments
 * @param {Set<string>} params.existingHashes
 * @param {object} params.config
 */
export async function postReview(octokit, {
  owner,
  repo,
  pull_number,
  commitSha,
  comments,
  existingHashes,
  config
}) {
  if (comments.length === 0) {
    log.info('No comments to post');
    return { posted: 0, skipped: 0 };
  }

  const maxComments = config?.review?.maxCommentsPerReview ?? 15;

  // Deduplicate and format comments
  const newComments = [];
  let skippedDuplicates = 0;

  for (const comment of comments.slice(0, maxComments)) {
    const formattedBody = formatCommentBody(comment);
    const hash = hashComment(comment.path, comment.line, formattedBody);

    if (existingHashes.has(hash)) {
      log.debug('Skipping duplicate comment', { path: comment.path, line: comment.line });
      skippedDuplicates++;
      continue;
    }

    newComments.push({
      path: comment.path,
      line: comment.line,
      side: 'RIGHT',  // Comment on the new version of the file
      body: formattedBody
    });
  }

  if (newComments.length === 0) {
    log.info('All comments were duplicates, skipping review submission');
    return { posted: 0, skipped: skippedDuplicates };
  }

  log.info(`Submitting review with ${newComments.length} comments`);

  // Batch all comments into a single review submission
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number,
    commit_id: commitSha,
    event: 'COMMENT',  // COMMENT doesn't block merge; use REQUEST_CHANGES for blocking
    body: buildReviewSummary(comments, skippedDuplicates),
    comments: newComments
  });

  log.info('Review posted successfully', {
    posted: newComments.length,
    skipped: skippedDuplicates
  });

  return { posted: newComments.length, skipped: skippedDuplicates };
}

/**
 * Builds a summary body for the overall review event.
 */
function buildReviewSummary(comments, skipped) {
  const warnings = comments.filter(c => c.severity === 'warning' || c.severity === 'error').length;
  const suggestions = comments.filter(c => c.severity === 'suggestion').length;
  const infos = comments.filter(c => c.severity === 'info').length;

  const lines = [
    '## 🤖 AI Code Review',
    '',
    `Analyzed ${new Set(comments.map(c => c.path)).size} file(s) and found:`,
    `- 🚨 ${warnings} warning(s)`,
    `- 📝 ${suggestions} suggestion(s)`,
    `- 💡 ${infos} informational note(s)`
  ];

  if (skipped > 0) {
    lines.push(`- *(${skipped} duplicate comment(s) suppressed)*`);
  }

  lines.push('', '*This is an automated review. Please use your judgment on each suggestion.*');
  return lines.join('\n');
}

/**
 * @typedef {Object} ReviewComment
 * @property {string} path - File path relative to repo root
 * @property {number} line - Line number in the new file
 * @property {'info'|'suggestion'|'warning'|'error'} severity
 * @property {string} title - One-line summary
 * @property {string} [body] - Detailed explanation
 * @property {string} [suggestion] - Code suggestion for GitHub suggestion block
 */

/**
 * fetchPRDiff.js — Retrieves and parses pull request diffs from the GitHub API.
 *
 * Design decisions:
 * - We use the Octokit REST client rather than raw fetch to get built-in
 *   pagination, retry, and rate-limit handling via plugins.
 * - parse-diff converts the raw unified diff into a structured AST that
 *   downstream modules can work with without regex parsing.
 * - We expose both the raw diff string and the parsed structure so callers
 *   can choose their level of abstraction.
 * - File filtering (ignored patterns, extensions) is applied here as an
 *   early gate to avoid sending irrelevant data to the AI.
 */

import minimatch from 'minimatch';
import parseDiff from 'parse-diff';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('fetchPRDiff');

/**
 * Fetches the diff for a pull request.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, pull_number: number }} params
 * @returns {Promise<string>} Raw unified diff string
 */
export async function fetchRawDiff(octokit, { owner, repo, pull_number }) {
  log.info('Fetching PR diff', { owner, repo, pull_number });

  // Request diff format explicitly via Accept header
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: 'diff' }
  });

  // Octokit returns the diff as response.data when format is 'diff'
  const diff = response.data;

  if (typeof diff !== 'string' || diff.trim().length === 0) {
    throw new Error('Received empty or invalid diff from GitHub API');
  }

  log.debug('Raw diff fetched', { bytes: diff.length });
  return diff;
}

/**
 * Fetches PR metadata (base/head SHAs, title, etc.)
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {{ owner: string, repo: string, pull_number: number }} params
 */
export async function fetchPRMetadata(octokit, { owner, repo, pull_number }) {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number
  });

  return {
    title: data.title,
    body: data.body,
    baseSha: data.base.sha,
    headSha: data.head.sha,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    changedFiles: data.changed_files,
    additions: data.additions,
    deletions: data.deletions
  };
}

/**
 * Parses a raw diff string into structured file hunks.
 * Filters out files that match ignore patterns or have ignored extensions.
 *
 * @param {string} rawDiff
 * @param {object} filterConfig - config.filters
 * @returns {Array<ParsedFile>} Filtered, structured file diffs
 */
export function parsePRDiff(rawDiff, filterConfig = {}) {
  const {
    ignoredFilePatterns = [],
    ignoredExtensions = [],
    maxLinesPerFile = 500
  } = filterConfig;

  const files = parseDiff(rawDiff);
  log.info(`Parsed diff: ${files.length} total files`);

  const filtered = files.filter(file => {
    const filePath = file.to || file.from || '';

    // Skip deleted files (no 'to' path means deletion)
    if (file.to === '/dev/null') {
      log.debug(`Skipping deleted file: ${filePath}`);
      return false;
    }

    // Skip files matching ignore glob patterns
    const isIgnoredPattern = ignoredFilePatterns.some(pattern =>
      minimatch(filePath, pattern, { matchBase: true, dot: true })
    );
    if (isIgnoredPattern) {
      log.debug(`Skipping ignored pattern match: ${filePath}`);
      return false;
    }

    // Skip binary/asset file extensions
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (ignoredExtensions.includes(ext)) {
      log.debug(`Skipping ignored extension: ${filePath} (${ext})`);
      return false;
    }

    return true;
  });

  log.info(`Files after filtering: ${filtered.length}`);

  // Enrich each file with derived metadata useful for downstream processing
  return filtered.map(file => {
    const changedLines = extractChangedLines(file);
    return {
      path: file.to || file.from,
      hunks: file.chunks,
      changedLines,
      additions: changedLines.filter(l => l.type === 'add').length,
      deletions: changedLines.filter(l => l.type === 'del').length,
      isTruncated: changedLines.length > maxLinesPerFile,
      // Limit lines per file to control token usage
      changedLinesSlice: changedLines.slice(0, maxLinesPerFile)
    };
  });
}

/**
 * Extracts only added/deleted lines with their line numbers from parsed hunks.
 * This focuses AI analysis on the actual changes rather than context lines.
 *
 * @param {object} file - Parsed diff file object
 * @returns {Array<{ lineNumber: number, type: 'add'|'del', content: string }>}
 */
function extractChangedLines(file) {
  const changed = [];

  for (const chunk of (file.chunks || [])) {
    for (const change of (chunk.changes || [])) {
      if (change.type === 'add' || change.type === 'del') {
        changed.push({
          lineNumber: change.type === 'add' ? change.ln : change.ln1,
          type: change.type,
          content: change.content  // Includes leading '+'/'-'
        });
      }
    }
  }

  return changed;
}

/**
 * Formats a parsed file's hunks into a readable diff string for AI context.
 * Includes both context lines and changed lines so the AI has surrounding code.
 *
 * @param {object} parsedFile
 * @returns {string}
 */
export function formatFileForAI(parsedFile) {
  const lines = [`File: ${parsedFile.path}`];

  for (const hunk of parsedFile.hunks) {
    lines.push(`\n@@ Hunk: lines ${hunk.newStart}-${hunk.newStart + hunk.newLines} @@`);
    for (const change of hunk.changes) {
      lines.push(change.content);
    }
  }

  return lines.join('\n');
}

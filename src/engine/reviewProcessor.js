/**
 * reviewProcessor.js — Orchestrates the end-to-end review pipeline for a single PR.
 *
 * Design decisions:
 * - This module is the "pipeline conductor": it sequences diff fetching,
 *   filtering, AI analysis, and comment posting. Individual modules handle
 *   their own concerns; this module wires them together.
 * - Files are processed sequentially (not in parallel) to respect OpenAI rate
 *   limits and avoid thundering-herd issues. Parallelism could be added later
 *   with a semaphore if latency becomes a concern.
 * - Token budget tracking ensures we stay within cost bounds even for large PRs.
 *   When the budget is exhausted, remaining files are skipped with a log message.
 * - Guidelines are loaded once and injected into each file prompt, allowing
 *   project conventions to inform every review comment.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  fetchRawDiff,
  fetchPRMetadata,
  parsePRDiff,
  formatFileForAI
} from '../github/fetchPRDiff.js';
import {
  fetchExistingCommentHashes,
  postReview
} from '../github/postReviewComment.js';
import { analyzeFileDiff } from '../ai/analyzeCode.js';
import { shouldSkipFile, filterComments, isLineInDiff } from './ruleFilter.js';
import { TokenBudget, estimateTokens } from '../utils/tokenManager.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('reviewProcessor');

/**
 * Runs the full PR review pipeline.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.pull_number
 * @param {string} params.commitSha
 * @param {object} params.config - Full merged config object
 */
export async function processReview(octokit, {
  owner,
  repo,
  pull_number,
  commitSha,
  config
}) {
  log.info('Starting PR review', { owner, repo, pull_number });

  // === Step 1: Fetch PR metadata and raw diff ===
  const [metadata, rawDiff] = await Promise.all([
    fetchPRMetadata(octokit, { owner, repo, pull_number }),
    fetchRawDiff(octokit, { owner, repo, pull_number })
  ]);

  log.info('PR metadata fetched', {
    title: metadata.title,
    changedFiles: metadata.changedFiles,
    additions: metadata.additions,
    deletions: metadata.deletions
  });

  // === Step 2: Parse and filter diff ===
  const parsedFiles = parsePRDiff(rawDiff, {
    ...config.filters,
    maxLinesPerFile: config.review?.maxLinesPerFile
  });

  const maxFiles = config.review?.maxFilesPerReview ?? 20;
  const filesToReview = parsedFiles.slice(0, maxFiles);

  if (parsedFiles.length > maxFiles) {
    log.warn(`PR has ${parsedFiles.length} files, limiting to ${maxFiles}`);
  }

  // === Step 3: Load optional guidelines ===
  const guidelines = loadGuidelines(config);

  // === Step 4: Pre-fetch existing comments for deduplication ===
  const existingHashes = await fetchExistingCommentHashes(octokit, {
    owner, repo, pull_number
  });

  // === Step 5: Initialize token budget ===
  // Reserve ~50k tokens total across all files for a PR review run.
  // This is configurable to control costs.
  const TOTAL_BUDGET = 50_000;
  const budget = new TokenBudget(TOTAL_BUDGET);

  const allComments = [];

  // === Step 6: Analyze each file ===
  for (const file of filesToReview) {
    const { skip, reason } = shouldSkipFile(file, config);
    if (skip) {
      log.info(`Skipping ${file.path}: ${reason}`);
      continue;
    }

    // Format diff for AI consumption
    const diffContent = formatFileForAI(file);
    const estimatedTokens = estimateTokens(diffContent) + 200; // 200 for prompt overhead

    if (!budget.allocate(estimatedTokens)) {
      log.warn(`Token budget exhausted, skipping remaining files`, budget.summary());
      break;
    }

    log.info(`Analyzing file: ${file.path}`);

    try {
      const rawComments = await analyzeFileDiff({
        filePath: file.path,
        diffContent,
        guidelines,
        prTitle: metadata.title,
        aiConfig: config.ai
      });

      // Post-filter: remove noise and validate line numbers
      const filteredComments = filterComments(rawComments, file.path, config)
        .filter(comment => isLineInDiff(comment, file));

      log.info(`File analysis done`, {
        file: file.path,
        raw: rawComments.length,
        filtered: filteredComments.length
      });

      allComments.push(...filteredComments);

    } catch (err) {
      // Don't let a single file failure abort the entire review
      log.error(`Failed to analyze ${file.path}`, { error: err.message });
    }
  }

  // === Step 7: Post review ===
  log.info(`Review pipeline complete`, {
    totalComments: allComments.length,
    tokenUsage: budget.summary()
  });

  if (allComments.length === 0) {
    log.info('No actionable comments found, skipping review post');
    return { posted: 0, skipped: 0 };
  }

  const result = await postReview(octokit, {
    owner,
    repo,
    pull_number,
    commitSha,
    comments: allComments,
    existingHashes,
    config
  });

  log.info('Review posted', result);
  return result;
}

/**
 * Attempts to load repository coding guidelines from the configured file.
 * Returns null if guidelines are disabled or the file is not found.
 *
 * @param {object} config
 * @returns {string|null}
 */
function loadGuidelines(config) {
  if (!config.guidelines?.enabled) return null;

  const guidelinesFile = config.guidelines?.guidelinesFile ?? 'CONTRIBUTING.md';
  const guidelinesPath = join(process.cwd(), guidelinesFile);

  if (!existsSync(guidelinesPath)) {
    log.debug(`Guidelines file not found: ${guidelinesFile}`);
    return null;
  }

  try {
    const content = readFileSync(guidelinesPath, 'utf-8');
    const maxTokens = config.guidelines?.maxGuidelinesTokens ?? 500;
    const maxChars = maxTokens * 4;

    if (content.length > maxChars) {
      log.debug(`Truncating guidelines to ${maxTokens} tokens`);
      return content.slice(0, maxChars) + '\n[...truncated]';
    }

    log.info(`Loaded guidelines from ${guidelinesFile}`);
    return content;
  } catch (err) {
    log.warn(`Failed to read guidelines file`, { error: err.message });
    return null;
  }
}

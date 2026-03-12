/**
 * index.js — Entry point and GitHub event handler.
 *
 * Design decisions:
 * - Environment variables are validated eagerly at startup so failures are
 *   loud and immediate rather than surfacing mid-pipeline.
 * - Octokit is configured with the retry and throttling plugins to handle
 *   GitHub's rate limits gracefully. This is especially important in orgs
 *   where many PRs fire simultaneously.
 * - Top-level error handling ensures the process exits with code 1 on failure,
 *   which makes the GitHub Actions step fail. Combined with continue-on-error
 *   in the workflow, this allows graceful degradation without blocking merges.
 */

import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { loadConfig } from './utils/config.js';
import { processReview } from './engine/reviewProcessor.js';
import logger, { createContextLogger } from './utils/logger.js';

const log = createContextLogger('index');

// Build an Octokit class with retry and throttling plugins
const OctokitWithPlugins = Octokit.plugin(retry, throttling);

/**
 * Validates required environment variables and returns a structured context object.
 * Throws descriptively if anything is missing.
 */
function validateEnvironment() {
  const required = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PR_NUMBER: process.env.PR_NUMBER,
    REPO_OWNER: process.env.REPO_OWNER,
    REPO_NAME: process.env.REPO_NAME,
    COMMIT_SHA: process.env.COMMIT_SHA
  };

  const missing = Object.entries(required)
    .filter(([, val]) => !val)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const prNumber = parseInt(required.PR_NUMBER, 10);
  if (isNaN(prNumber)) {
    throw new Error(`PR_NUMBER is not a valid integer: ${required.PR_NUMBER}`);
  }

  return {
    githubToken: required.GITHUB_TOKEN,
    owner: required.REPO_OWNER,
    repo: required.REPO_NAME,
    pull_number: prNumber,
    commitSha: required.COMMIT_SHA
  };
}

/**
 * Creates a configured Octokit instance with rate limit handling.
 */
function createOctokit(token) {
  return new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        log.warn(`Rate limit hit for ${options.method} ${options.url}`, {
          retryAfter,
          retryCount
        });
        // Retry up to 3 times on rate limit
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        log.warn(`Secondary rate limit for ${options.method} ${options.url}`);
        return true;
      }
    },
    retry: {
      doNotRetry: ['429']  // Let throttling handle rate limits
    }
  });
}

/**
 * Main execution function.
 */
async function main() {
  log.info('AI PR Review Bot starting');

  // Validate environment first — fail fast with clear message
  let context;
  try {
    context = validateEnvironment();
  } catch (err) {
    log.error(`Environment validation failed: ${err.message}`);
    process.exit(1);
  }

  log.info('Environment validated', {
    owner: context.owner,
    repo: context.repo,
    pr: context.pull_number,
    sha: context.commitSha.slice(0, 8)
  });

  // Load configuration (default + optional repo override)
  const config = loadConfig(process.cwd());
  log.debug('Configuration loaded', { model: config.ai?.model });

  // Initialize GitHub API client
  const octokit = createOctokit(context.githubToken);

  // Run the review pipeline
  try {
    const result = await processReview(octokit, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pull_number,
      commitSha: context.commitSha,
      config
    });

    log.info('Review completed successfully', result);
    process.exit(0);

  } catch (err) {
    log.error('Review pipeline failed', {
      error: err.message,
      stack: err.stack
    });
    process.exit(1);
  }
}

// Execute
main();

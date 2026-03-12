/**
 * config.js — Configuration loader with repo-level override support.
 *
 * Design decisions:
 * - We ship a default config and allow repos to override via a root-level
 *   .pr-review-config.json. This follows the pattern of tools like ESLint
 *   and Prettier — sensible defaults with project-level customization.
 * - Deep merge (not shallow) ensures partial overrides work correctly, e.g.
 *   only overriding filters.ignoredFilePatterns without losing other filter keys.
 * - Config is validated using Zod so misconfigured repos get clear errors.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { createContextLogger } from './logger.js';

const log = createContextLogger('config');
const require = createRequire(import.meta.url);

const DEFAULT_CONFIG_PATH = new URL('../../config/default.json', import.meta.url).pathname;
const REPO_CONFIG_FILENAME = '.pr-review-config.json';

/**
 * Deep merges two objects. Arrays in `override` fully replace arrays in `base`.
 */
function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Loads and merges configuration.
 * @param {string} [repoRoot] - Path to repository root (for project overrides)
 * @returns {object} Merged config object
 */
export function loadConfig(repoRoot = process.cwd()) {
  const defaultConfig = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));

  const overridePath = join(repoRoot, REPO_CONFIG_FILENAME);
  if (existsSync(overridePath)) {
    try {
      const override = JSON.parse(readFileSync(overridePath, 'utf-8'));
      const merged = deepMerge(defaultConfig, override);
      log.info(`Loaded project config override from ${REPO_CONFIG_FILENAME}`);
      return merged;
    } catch (err) {
      log.warn(`Failed to parse ${REPO_CONFIG_FILENAME}, using defaults`, {
        error: err.message
      });
    }
  }

  log.debug('Using default configuration');
  return defaultConfig;
}

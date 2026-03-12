/**
 * promptTemplates.js — Prompt construction for PR code review analysis.
 *
 * Design decisions:
 * - Prompts are separated from the API client so they can be tuned independently
 *   and tested without making API calls.
 * - The system prompt establishes a "senior engineer" persona with explicit
 *   instructions to avoid trivial comments. This significantly improves signal
 *   quality by reducing noise from obvious style feedback.
 * - We use structured JSON output (enforced via response_format) so the response
 *   parser has a reliable contract rather than parsing free text.
 * - Guidelines context is injected optionally — when present it allows
 *   project-specific conventions to inform the review.
 */

/**
 * System prompt that establishes review persona and output contract.
 * This is kept stable across requests; only the user prompt changes per file.
 */
export const SYSTEM_PROMPT = `You are a senior software engineer performing a pull request code review.

Your goal is to identify real issues that affect correctness, security, performance, 
maintainability, or readability. You do NOT comment on:
- Code formatting or indentation (handled by linters)
- Minor naming preferences unless genuinely confusing  
- Style choices that don't affect maintainability
- Lines that were not changed in this diff

Focus ONLY on the added lines (marked with +) in the diff. Context lines (unmarked) 
are provided for understanding only.

For each issue found, respond with a JSON array. Each element must have:
{
  "line": <integer - the line number in the new file where the issue is>,
  "severity": <"info" | "suggestion" | "warning" | "error">,
  "title": <string - one concise sentence describing the issue>,
  "body": <string - explanation of why this is an issue and its impact>,
  "suggestion": <string or null - specific corrected code if applicable>
}

Severity guide:
- "error": Bug, security vulnerability, data loss risk, or crash potential
- "warning": Logic issue, performance problem, or likely unintended behavior  
- "suggestion": Improvement that would meaningfully aid maintainability or clarity
- "info": Noteworthy pattern worth awareness but not requiring change

Return ONLY the JSON array. No markdown fences, no preamble, no explanation outside the array.
If you find no meaningful issues, return an empty array: []`;

/**
 * Builds the user prompt for a single file review.
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {string} params.diffContent - Formatted diff with context
 * @param {string} [params.guidelines] - Optional repo coding guidelines
 * @param {string} [params.prTitle] - PR title for additional context
 * @returns {string}
 */
export function buildFileReviewPrompt({ filePath, diffContent, guidelines, prTitle }) {
  const parts = [];

  if (prTitle) {
    parts.push(`PR Context: "${prTitle}"\n`);
  }

  if (guidelines) {
    parts.push(`Project Guidelines (apply these when reviewing):\n${guidelines}\n`);
  }

  parts.push(`Review the following diff for file: ${filePath}`);
  parts.push('');
  parts.push(diffContent);

  return parts.join('\n');
}

/**
 * Builds a prompt for multi-file context analysis.
 * Used when a change in one file affects the review of another.
 *
 * @param {Array<{ path: string, diff: string }>} fileContexts
 * @returns {string}
 */
export function buildMultiFilePrompt(fileContexts) {
  const parts = [
    'Review the following multi-file diff. Consider interactions between files.',
    ''
  ];

  for (const { path, diff } of fileContexts) {
    parts.push(`=== ${path} ===`);
    parts.push(diff);
    parts.push('');
  }

  parts.push('Return a flat JSON array of issues across all files. Include "path" in each object.');
  return parts.join('\n');
}

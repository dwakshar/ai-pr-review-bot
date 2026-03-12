# AI PR Review Bot

A production-grade AI-powered pull request review bot built with Node.js, GitHub Actions, and OpenAI. It analyzes code diffs and posts contextual inline review comments directly on GitHub pull requests.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                     GitHub Actions Runner                         │
│                                                                   │
│  pull_request event ──► src/index.js (entry + env validation)     │
│                               │                                   │
│                    ┌──────────▼──────────┐                        │
│                    │  reviewProcessor.js │  ← orchestrator        │
│                    └──────────┬──────────┘                        │
│          ┌──────────┬─────────┼──────────┬──────────┐             │
│          ▼          ▼         ▼          ▼          ▼             │
│    fetchPRDiff  ruleFilter  analyzeCode  ruleFilter  postReview   │
│    (GitHub API) (pre-filter) (OpenAI)  (post-filter)(GitHub API)  │
└───────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| `src/index.js` | Entry point, env validation, Octokit setup |
| `src/engine/reviewProcessor.js` | Pipeline orchestration, token budget management |
| `src/github/fetchPRDiff.js` | GitHub API diff fetching and diff parsing |
| `src/github/postReviewComment.js` | Batch review submission, deduplication |
| `src/ai/analyzeCode.js` | OpenAI API client, retry logic, response parsing |
| `src/ai/promptTemplates.js` | Prompt construction and tuning |
| `src/engine/ruleFilter.js` | Pre/post-analysis heuristic filtering |
| `src/utils/tokenManager.js` | Token estimation, truncation, budget tracking |
| `src/utils/config.js` | Config loading with project-level overrides |
| `src/utils/logger.js` | Structured logging (Winston) |

---

## Setup

### 1. Add Secrets to Your Repository

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | Your OpenAI API key (requires GPT-4o access) |

> `GITHUB_TOKEN` is provided automatically by GitHub Actions.

### 2. Add the Workflow File

Copy `.github/workflows/pr-review.yml` to your target repository. The bot will automatically trigger on PR events.

### 3. (Optional) Add Project Configuration

Create `.pr-review-config.json` in your repository root to customize behavior:

```json
{
  "review": {
    "maxFilesPerReview": 10,
    "maxCommentsPerReview": 8
  },
  "ai": {
    "model": "gpt-4o",
    "temperature": 0.1
  },
  "filters": {
    "severityThreshold": "suggestion",
    "ignoredFilePatterns": ["**/generated/**", "**/*.pb.js"]
  },
  "guidelines": {
    "enabled": true,
    "guidelinesFile": "CONTRIBUTING.md"
  }
}
```

---

## Key Design Decisions

### Why review batching instead of individual comments?
The GitHub Reviews API (`createReview`) bundles all inline comments into a single review event. This means contributors receive one notification instead of N, and the PR timeline stays clean.

### Why sequential file processing?
OpenAI rate limits punish burst requests. Sequential processing with retry/backoff handles rate limits gracefully. For large PRs, the token budget gate (`TokenBudget`) stops processing early rather than failing.

### Why strict JSON output from AI?
Free-text AI responses require fragile regex parsing. By instructing the model to return a structured JSON array and validating each field, we get a reliable contract. Malformed responses are logged and skipped rather than crashing the pipeline.

### Why two-stage filtering?
- **Pre-filter (ruleFilter.shouldSkipFile)**: Cheap heuristics before spending API tokens. Catches migration files, snapshots, trivially small diffs.
- **Post-filter (ruleFilter.filterComments)**: Quality gates on AI output. Prevents spam from high comment density, enforces severity thresholds, validates line numbers against the actual diff.

### Why deduplication?
PRs with multiple commits (`synchronize` events) would re-trigger the bot. Without deduplication, every push would re-post identical comments. We hash `(file, line, body)` of existing bot comments and skip matches.

---

## Configuration Reference

See `config/default.json` for all available options with documentation.

```
config/
└── default.json       ← Shipped defaults (committed to this repo)

.pr-review-config.json ← Per-project override (in your target repo)
```

---

## Running Locally

```bash
# Install dependencies
npm install

# Set environment variables
export GITHUB_TOKEN=ghp_...
export OPENAI_API_KEY=sk-...
export PR_NUMBER=42
export REPO_OWNER=your-org
export REPO_NAME=your-repo
export COMMIT_SHA=abc1234...

# Run the bot against a real PR
node src/index.js

# Run with debug logging
DEBUG=true node src/index.js
```

---

## Running Tests

```bash
npm test
npm run test:coverage
```

---

## Project Structure

```
ai-pr-review-bot/
├── .github/
│   └── workflows/
│       └── pr-review.yml       # GitHub Actions workflow
├── src/
│   ├── index.js                # Entry point + event handler
│   ├── github/
│   │   ├── fetchPRDiff.js      # Diff fetching + parsing
│   │   └── postReviewComment.js # Review submission + deduplication
│   ├── ai/
│   │   ├── analyzeCode.js      # OpenAI client + response parsing
│   │   └── promptTemplates.js  # Prompt construction + tuning
│   ├── engine/
│   │   ├── reviewProcessor.js  # Pipeline orchestration
│   │   └── ruleFilter.js       # Heuristic filtering engine
│   └── utils/
│       ├── logger.js           # Structured logging (Winston)
│       ├── tokenManager.js     # Token estimation + budget
│       └── config.js           # Config loader
├── tests/
│   ├── tokenManager.test.js
│   └── ruleFilter.test.js
├── config/
│   └── default.json            # Default configuration
├── package.json
└── README.md
```

---

## Extending the Bot

### Adding a new file filter
Add a check in `src/engine/ruleFilter.js` → `shouldSkipFile()`. Return `{ skip: true, reason: '...' }`.

### Tuning the AI prompt
Edit `src/ai/promptTemplates.js` → `SYSTEM_PROMPT`. The system prompt has the highest impact on comment quality.

### Supporting a different AI provider
Replace `src/ai/analyzeCode.js` with a new implementation that exports the same `analyzeFileDiff()` signature. The rest of the pipeline is provider-agnostic.

### Adding comment severity levels
The severity enum is defined in `postReviewComment.js` → `SEVERITY_LABELS`. Add a new key and update `ruleFilter.js` → `SEVERITY_ORDER`.

---

## Cost Estimates

| PR Size | Files | ~Tokens | ~Cost (GPT-4o) |
|---------|-------|---------|----------------|
| Small | 3-5 | ~8k | ~$0.05 |
| Medium | 10 | ~20k | ~$0.12 |
| Large | 20 | ~45k | ~$0.27 |

The token budget is capped at 50k tokens per run by default.

---

## License

MIT

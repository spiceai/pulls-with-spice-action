# Pulls with Spice Action

A GitHub Action that enforces standards for pull requests with extra flavor.

**Permissive by default** - All checks are opt-in. Enable only the features you need.

## Features

- **Title & Description Validation**: Enforce minimum lengths for PR titles and descriptions
- **Label Requirements**: Require specific labels (any or all from a predefined list)
- **Label Categories**: Require labels from specific category prefixes (e.g., `kind/`, `area/`)
- **Banned Labels**: Prevent the use of certain labels
- **Assignee Requirements**: Require at least one assignee
- **Conventional Commit Enforcement**: Require specific issue types in PR title/description
- **Milestone Requirements**: Require PRs to have a milestone
- **Branch Naming**: Enforce branch naming conventions
- **Draft PR Enforcement**: Require PRs to be marked as ready for review
- **Auto-labeling**: Automatically apply labels based on:
  - Changed file paths
  - PR title patterns (conventional commit types)
  - PR description patterns
- **AI Auto-labeling**: Smart analysis using Spice Cloud for intelligent label suggestions
- **Auto-assignment**: Automatically assign PR authors or specific users
- **Smart Comments**: Post detailed status reports with suggested fixes
- **Customizable Messages**: Provide custom error messages for any check

## Quick Start

Create a workflow file (e.g., `.github/workflows/pulls-with-spice.yml`) in your repository:

```yaml
name: Enforce PR With Spice

on:
  pull_request:
    types: [opened, edited, labeled, unlabeled, assigned, unassigned, synchronize]

jobs:
  enforce-pull-with-spice:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: spiceai/pulls-with-spice-action@v2
        with:
          # Enable only what you need - all checks are off by default
          auto_label: 'true'
          auto_assign_author: 'true'
```

## Full Configuration Example

```yaml
- uses: spiceai/pulls-with-spice-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    # Title and description requirements
    require_title_min_length: '10'
    require_description_min_length: '50'
    # Label requirements
    required_labels_any: 'bug,feature,enhancement'
    required_labels_all: 'triage'
    required_label_prefixes: 'kind/,area/'
    banned_labels: 'invalid,wontfix'
    # Other requirements
    require_assignee: 'true'
    required_issue_types: 'feat,fix,docs,chore'
    require_milestone: 'true'
    branch_name_pattern: '^(feature|fix|docs|chore)/.*'
    # Automation features
    auto_label: 'true'
    auto_label_type: 'true'
    auto_assign: 'true'
    auto_assign_author: 'true'
```

## Inputs

| Input                            | Description                                              | Required | Default               |
| -------------------------------- | -------------------------------------------------------- | -------- | --------------------- |
| `github_token`                   | GitHub token for API calls and posting comments          | No       | `${{ github.token }}` |
| `require_title_min_length`       | Minimum length of the PR title                           | No       | `0`                   |
| `require_description_min_length` | Minimum length of the PR description                     | No       | `0`                   |
| `required_labels_any`            | Any of these labels must be present (comma-separated)    | No       | -                     |
| `required_labels_all`            | All of these labels must be present (comma-separated)    | No       | -                     |
| `required_label_prefixes`        | Require a label from each prefix (comma-separated)       | No       | -                     |
| `banned_labels`                  | None of these labels should be present (comma-separated) | No       | -                     |
| `require_assignee`               | Require at least one assignee                            | No       | `false`               |
| `enforce_draft`                  | Require non-draft pull requests                          | No       | `false`               |
| `required_issue_types`           | PR must include one of these conventional commit types   | No       | -                     |
| `require_issue_type`             | Require GitHub's native issue **Type** (issues only)     | No       | `false`               |
| `allowed_issue_types`            | Restrict the native Type to these (comma-separated)      | No       | -                     |
| `require_priority_for_types`     | Require a priority for these types (comma-separated)     | No       | -                     |
| `priority_field_name`            | Name of the native single-select priority field          | No       | `Priority`            |
| `require_milestone`              | Require a milestone on the PR                            | No       | `false`               |
| `branch_name_pattern`            | Regex pattern that branch names must match               | No       | -                     |
| `auto_label`                     | Enable automatic labeling based on file paths            | No       | `false`               |
| `auto_label_type`                | Add type labels based on conventional commit prefix      | No       | `false`               |
| `auto_assign`                    | Enable automatic assignment                              | No       | `false`               |
| `auto_assign_author`             | Assign the PR author automatically                       | No       | `false`               |
| `auto_assign_users`              | Users to auto-assign (comma-separated)                   | No       | -                     |
| `custom_error_messages`          | JSON object with custom error messages                   | No       | -                     |
| `spice_api_key`                  | Spice Cloud (or OpenAI) API key for AI features          | No       | -                     |
| `spice_cloud_region`             | Spice Cloud region (`us-east-1`, `us-west-2`)            | No       | `us-east-1`           |
| `ai_auto_label`                  | Enable AI label review after the rule-based pass         | No       | `false`               |
| `ai_model`                       | Model to use for the AI pass                             | No       | `openai`              |

## Native Type and Priority (issues)

GitHub now has first-class **Type** and custom **issue fields** on issues, so type and
priority no longer have to be encoded in labels like `kind/bug` or `priority/p1`. These
inputs enforce the native fields directly:

```yaml
- uses: spiceai/pulls-with-spice-action@v2
  with:
    require_issue_type: 'true'
    allowed_issue_types: 'Bug,Feature,Task'
    # Urgency is meaningful for a defect and mostly noise for a chore, so only
    # bugs are required to carry one.
    require_priority_for_types: 'Bug'
    priority_field_name: 'Priority'
```

An issue typed `Bug` must then also have a `Priority` set; a `Task` needs only its type.

**These apply to issues only.** GitHub exposes `issueType` and issue field values on the
`Issue` GraphQL type and not on `PullRequest` — a pull request has no native type or
priority to set, so enforcing one would fail every PR for something GitHub gives no way
to satisfy. When the action runs on a pull request it logs that it is skipping these
checks and moves on. To enforce them, run the action on issue events:

```yaml
on:
  issues:
    types: [opened, edited, labeled, unlabeled, reopened]
```

If the fields cannot be read — the organization has no issue types configured, or the
token lacks the scope — the action **warns and skips** rather than failing, so a
permissions gap never looks like a policy violation.

## Recommended workflow hygiene

This action can add labels and assignees, and those writes emit `labeled` / `assigned`
events. If your workflow also *subscribes* to those events, each run triggers further
runs, and several can then race on the same pull request. Add a `concurrency` group so
only the newest run for a given PR survives:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true
```

Keep the `labeled`/`unlabeled` triggers — they are what re-runs the check when someone
adds the missing label — and let `concurrency` collapse the redundant runs.

## Label Prefixes

The `required_label_prefixes` input requires at least one label from each specified prefix category:

```yaml
required_label_prefixes: 'kind/,area/'
```

This ensures PRs have both a `kind/` label (e.g., `kind/bug`, `kind/feature`) and an `area/` label (e.g., `area/docs`, `area/ci`).

## Auto-labeling

When `auto_label` is enabled, the action automatically applies labels based on:

### Built-in Rules

| Label               | Triggered By                                                    |
| ------------------- | --------------------------------------------------------------- |
| `area/docs`         | Files in `docs/`, `README`, `.md`, `CONTRIBUTING`, `LICENSE`    |
| `area/ci`           | Files in `.github/`, `Jenkinsfile`, `.travis`, `.circleci`      |
| `area/tests`        | Files in `test/`, `tests/`, `__tests__/`, `spec/`               |
| `area/config`       | Config files: `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, `.env` |
| `kind/dependencies` | Lock files: `package-lock.json`, `yarn.lock`, `go.sum`, etc.    |

### Type Labels from Conventional Commits

When `auto_label_type` is enabled, the action parses the PR title for conventional commit prefixes:

| Prefix      | Label               |
| ----------- | ------------------- |
| `feat:`     | `kind/feature`      |
| `fix:`      | `kind/bug`          |
| `docs:`     | `kind/docs`         |
| `style:`    | `kind/style`        |
| `refactor:` | `kind/refactor`     |
| `perf:`     | `kind/performance`  |
| `test:`     | `kind/test`         |
| `build:`    | `kind/build`        |
| `ci:`       | `kind/ci`           |
| `chore:`    | `kind/chore`        |
| `security:` | `kind/security`     |
| `deps:`     | `kind/dependencies` |

The auto-labeler keeps `kind/` labels mutually exclusive. If multiple `kind/` labels are detected, it keeps a single one, prioritizing conventional-commit type labels over path-based `kind/dependencies`.

## AI Auto-labeling (Spice Cloud)

The rule-based labelers above match file paths and title prefixes, so they cannot tell a
dependency bump that happens to touch a lock file from a feature that happens to touch
one. `ai_auto_label` adds a review pass that can correct them: it sends the PR's title,
description, changed files, current labels and the repository's full label list to a
model, and applies the additions and removals the model returns.

```yaml
- uses: spiceai/pulls-with-spice-action@v2
  with:
    spice_api_key: ${{ secrets.SPICE_API_KEY }}
    ai_auto_label: 'true'
```

It runs only when `ai_auto_label` is `true` **and** `spice_api_key` is set, and it never
fails the run: if the model is unreachable or answers with something unusable, the action
warns and keeps the rule-based labels.

Because it reviews rather than merely suggests, it **removes** labels too. It can only
apply labels that already exist in the repository, and it enforces the same
one-`kind/`-label rule as the rule-based pass.

### Region

Spice Cloud is reached over its regional data endpoints. Supported values:

```yaml
spice_cloud_region: 'us-west-2' # us-east-1 (default), us-west-2
```

An unrecognized region warns and falls back to `us-east-1`.

### Model

`ai_model` is passed through to the endpoint as the model name, so the value is whatever
your Spice Cloud deployment calls the model — the name under `models:` in your spicepod,
`openai` by default:

```yaml
ai_model: 'openai'
```

### Using OpenAI directly

A `spice_api_key` beginning with `sk-` is treated as an OpenAI API key and sent straight
to OpenAI, with `spice_cloud_region` ignored. Give `ai_model` a bare OpenAI model name:

```yaml
- uses: spiceai/pulls-with-spice-action@v2
  with:
    spice_api_key: ${{ secrets.OPENAI_API_KEY }}
    ai_auto_label: 'true'
    ai_model: 'gpt-5.4'
```

### Getting a Spice Cloud API Key

1. Sign up at [spice.ai](https://spice.ai)
2. Navigate to your account settings
3. Generate an API key
4. Add it as a repository secret named `SPICE_API_KEY`

## Auto-assignment

Enable automatic assignment to streamline the workflow:

```yaml
auto_assign: 'true'
auto_assign_author: 'true'  # Assign the PR author
auto_assign_users: 'reviewer1,reviewer2'  # Additional assignees
```

## Branch Naming Enforcement

Enforce branch naming conventions with regex patterns:

```yaml
branch_name_pattern: '^(feature|fix|docs|hotfix|release)/[a-z0-9-]+$'
```

## Conventional Commit Types

When `required_issue_types` is set, the action checks if the PR title matches the conventional commit format:

```text
type: description
type(scope): description
```

Supported types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

## Custom Error Messages

Customize error messages for any check:

```yaml
custom_error_messages: |
  {
    "title_too_short": "📝 Please provide a more descriptive title (min 10 chars).",
    "description_too_short": "📄 Add more context to your PR description.",
    "missing_any_labels": "🏷️ Please add at least one of the required labels.",
    "missing_all_labels": "🏷️ All required labels must be present.",
    "missing_category_kind": "🏷️ Please add a kind/ label (e.g., kind/feature, kind/bug).",
    "missing_category_area": "🏷️ Please add an area/ label to categorize this PR.",
    "banned_label": "🚫 This label is not allowed on PRs.",
    "no_assignee": "👤 Please assign someone to review this PR.",
    "invalid_issue_type": "📋 Use conventional commit format (e.g., feat: add feature).",
    "is_draft": "📝 Please mark your PR as ready for review.",
    "no_milestone": "🎯 Please add a milestone to this PR.",
    "invalid_branch_name": "🌿 Branch name doesn't match the required pattern."
  }
```

## Development

This action is built with TypeScript:

```bash
# Install dependencies
npm install

# Build the action
npm run build

# Run all checks (format, lint, build)
npm run all
```

## License

Apache-2.0

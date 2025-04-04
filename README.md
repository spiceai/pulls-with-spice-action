# Pulls with Spice Action

A GitHub Action that enforces quality standards for pull requests with extra flavor.

## Features

- Enforces minimum length for PR titles
- Enforces minimum length for PR descriptions
- Requires specific labels (any or all from a predefined list)
- Prevents the use of certain labels
- Requires assignees for PRs
- Enforces issue type requirements in PR body or title
- Posts error messages as comments on the pull request when checks fail
- Customizable error messages

## Usage

Create a workflow file (e.g., `.github/workflows/pulls-with-spice.yml`) in your repository:

```yaml
name: Enforce PR Quality

on:
  pull_request:
    types: [opened, edited, labeled, unlabeled, assigned, unassigned]

jobs:
  enforce-quality:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: spiceai/pulls-with-spice-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          require_title_min_length: '10'
          require_description_min_length: '50'
          required_labels_any: 'bug,feature,enhancement'
          required_labels_all: 'triage'
          banned_labels: 'invalid,wontfix'
          require_assignee: 'true'
          required_issue_types: 'bug,enhancement,task'
          enforce_draft: 'false'
          custom_error_messages: '{"title_too_short": "Please provide a more descriptive title."}'
```

## Inputs

| Input                            | Description                                                        | Required | Default               |
| -------------------------------- | ------------------------------------------------------------------ | -------- | --------------------- |
| `github_token`                   | GitHub token for posting comments to PR thread                     | No       | `${{ github.token }}` |
| `require_description_min_length` | Minimum length of the PR description                               | No       | `0`                   |
| `require_title_min_length`       | Minimum length of the PR title                                     | No       | `10`                  |
| `required_labels_any`            | Any of these labels must be present on the PR (comma-separated)    | No       | -                     |
| `required_labels_all`            | All of these labels must be present on the PR (comma-separated)    | No       | -                     |
| `banned_labels`                  | None of these labels should be present on the PR (comma-separated) | No       | -                     |
| `require_assignee`               | Whether to require at least one assignee                           | No       | `false`               |
| `enforce_draft`                  | Whether to enforce non-draft pull requests                         | No       | `false`               |
| `required_issue_types`           | PR must include one of these issue types (comma-separated)         | No       | -                     |
| `custom_error_messages`          | JSON object with custom error messages for various checks          | No       | -                     |

## Issue Type Enforcement

When `required_issue_types` is set, the action will check if the pull request title or description includes one of the specified issue types. Supported issue types are:

- `bug`: Fixes for bugs and defects
- `enhancement`: New features or improvements to existing functionality
- `task`: General tasks, maintenance, documentation, or other work items

The PR title or description should include the issue type in the format: `type: description` or `type(scope): description`.

## Custom Error Messages

You can provide custom error messages using a JSON object. The following keys are supported:

- `title_too_short` - Custom message for when the title is too short
- `description_too_short` - Custom message for when the description is too short
- `missing_any_labels` - Custom message for when none of the required labels are present
- `missing_all_labels` - Custom message for when some required labels are missing
- `banned_label` - Custom message for when a banned label is used
- `no_assignee` - Custom message for when an assignee is required but missing
- `invalid_issue_type` - Custom message for when the required issue type is missing
- `is_draft` - Custom message for when a draft PR is not allowed

## Development

This action is built with TypeScript:

```bash
# Install dependencies
npm install

# Build the action
npm run build

# Run tests
npm test
```

## License

Apache 2.0

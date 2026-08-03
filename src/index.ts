import * as core from '@actions/core';
import * as github from '@actions/github';

interface CustomErrorMessages {
  [key: string]: string;
}

interface Label {
  name: string;
}

interface User {
  login: string;
}

interface Milestone {
  title: string;
  number: number;
}

interface ContentObject {
  title: string;
  body?: string;
  labels?: Label[];
  assignees?: User[];
  draft?: boolean;
  milestone?: Milestone;
  number?: number;
  user?: User;
  head?: { ref: string };
  base?: { ref: string };
}

interface AutoLabelRule {
  label: string;
  paths: string[];
}

interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const PR_COMMENT_TITLE = 'Pull with Spice';

// Security: Maximum lengths to prevent DoS via extremely long inputs
const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 65536;
const MAX_LABEL_NAME_LENGTH = 100;
const MAX_LABELS_COUNT = 100;
const MAX_CHANGED_FILES = 3000;
/** Pages of `issueFieldValues` read before giving up — see `fetchNativeFields`. */
const MAX_FIELD_VALUE_PAGES = 10;
// Collect errors and success messages
const errorMessages: string[] = [];
const successMessages: string[] = [];
const autoAppliedLabels: string[] = [];
const suggestedFixes: string[] = [];

// ============================================================================
// Input Validation Functions
// ============================================================================

function sanitizeString(input: string | undefined, maxLength: number): string {
  if (!input) return '';
  return input.slice(0, maxLength);
}

async function run(): Promise<void> {
  try {
    // Accept either a pull request or an issue. Everything below except the
    // file-based checks (size labelling, path-based labels) is an issue-level concept
    // that applies equally to both, and GitHub's native type/priority fields exist
    // *only* on issues — so restricting this action to PRs would make those checks
    // unreachable.
    const pullRequest = (github.context.payload.pull_request ??
      github.context.payload.issue) as ContentObject | undefined;
    const isIssue = !github.context.payload.pull_request;

    if (!pullRequest) {
      core.setFailed(
        'This action works on pull requests and issues. Neither was found in the event payload.'
      );
      return;
    }

    // Sanitize inputs to prevent potential issues with extremely long content
    pullRequest.title = sanitizeString(pullRequest.title, MAX_TITLE_LENGTH);
    pullRequest.body = sanitizeString(pullRequest.body, MAX_BODY_LENGTH);

    // Limit labels to prevent abuse
    if (pullRequest.labels && pullRequest.labels.length > MAX_LABELS_COUNT) {
      pullRequest.labels = pullRequest.labels.slice(0, MAX_LABELS_COUNT);
    }

    const token = core.getInput('github_token');
    const octokit = token ? github.getOctokit(token) : null;

    // Determine which features need file data (optimization: only fetch if needed)
    const autoLabelEnabled = core.getInput('auto_label') === 'true';

    // Get changed files for auto-labeling (if enabled)
    let changedFiles: ChangedFile[] = [];
    if (octokit && pullRequest.number && !isIssue && autoLabelEnabled) {
      changedFiles = await getChangedFiles(octokit, pullRequest.number);
    }

    // Auto-labeling (runs before validation)
    if (octokit && pullRequest.number) {
      await performAutoLabeling(octokit, pullRequest, changedFiles);
    }

    // Auto-assign (if enabled)
    let didAutoAssign = false;
    if (octokit && pullRequest.number) {
      didAutoAssign = await performAutoAssign(octokit, pullRequest);
    }

    // Re-read the PR if we changed anything on it, so the checks below evaluate the
    // current state. This keyed off `auto_assign` before, which meant an author
    // assignment made via `auto_assign_author` left `pullRequest.assignees` stale and
    // `checkAssignees` failed a PR the action had just assigned.
    const needsRefresh = autoAppliedLabels.length > 0 || didAutoAssign;
    if (octokit && pullRequest.number && needsRefresh) {
      // `issues.get` serves both — a PR is an issue — and unlike `pulls.get` it also
      // works when this action runs on an issue event.
      const fresh = await octokit.rest.issues.get({
        ...github.context.repo,
        issue_number: pullRequest.number,
      });
      pullRequest.labels = fresh.data.labels as Label[];
      pullRequest.assignees = fresh.data.assignees as User[];
    }

    // Run all the quality checks
    checkTitle(pullRequest);
    checkDescription(pullRequest);
    checkLabels(pullRequest);
    checkLabelCategories(pullRequest);
    checkAssignees(pullRequest);
    checkIssueType(pullRequest);
    checkDraft(pullRequest);
    checkMilestone(pullRequest);
    checkBranchNaming(pullRequest);

    // Native GitHub type / priority fields (issues only — see checkNativeFields)
    if (octokit && pullRequest.number) {
      await checkNativeFields(octokit, pullRequest.number, isIssue);
    }

    // Post the report to the PR with all messages (errors and success)
    await postReportToPullRequest(errorMessages, successMessages);

    // If we have any errors, fail the action
    if (errorMessages.length > 0) {
      // Name the failing requirements in the failure itself. Previously every failure
      // read "See PR comments for details", so the run log was identical whether a PR
      // was missing a label, an assignee, or a milestone — anyone triaging a red check
      // had to open the PR to learn what it wanted.
      for (const message of errorMessages) {
        core.error(message);
      }
      core.setFailed(
        `Pull request checks failed (${errorMessages.length}): ${errorMessages.join(' | ')}`
      );
      return;
    }

    core.info('All pull request checks passed!');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

async function postReportToPullRequest(
  errors: string[],
  successes: string[]
): Promise<void> {
  try {
    const token = core.getInput('github_token');
    if (!token) {
      core.warning(
        'No GitHub token provided. Unable to post comments to the PR.'
      );
      return;
    }

    const octokit = github.getOctokit(token);
    const context = github.context;

    // Works for issues as well as pull requests — the comment endpoints are the same,
    // and without this the action would run its checks on an issue but silently post
    // nothing.
    const prNumber =
      context.payload.pull_request?.number ?? context.payload.issue?.number;
    if (!prNumber) {
      core.warning(
        'Could not find a pull request or issue number in context. Unable to post comments.'
      );
      return;
    }

    // Format the comment message
    const statusHeader =
      errors.length > 0
        ? `## 🔍 ${PR_COMMENT_TITLE} Failed\n\n`
        : `## ✅ ${PR_COMMENT_TITLE} Passed\n\n`;

    let statusBody = '';

    // Add auto-applied labels section
    if (autoAppliedLabels.length > 0) {
      statusBody += `### 🏷️ Auto-applied labels:\n\n`;
      autoAppliedLabels.forEach((label) => {
        statusBody += `- \`${label}\`\n`;
      });
      statusBody += `\n`;
    }

    // Add success messages first
    if (successes.length > 0) {
      statusBody += `### Passing checks:\n\n`;
      successes.forEach((success) => {
        statusBody += `- ✅ ${success}\n`;
      });
      statusBody += `\n`;
    }

    // Add error messages next
    if (errors.length > 0) {
      statusBody += `### Failed checks:\n\n`;
      errors.forEach((error) => {
        statusBody += `- ❌ ${error}\n`;
      });
      statusBody += `\n`;
    }

    // Add suggested fixes if available
    if (suggestedFixes.length > 0) {
      statusBody += `### 💡 Suggested fixes:\n\n`;
      suggestedFixes.forEach((fix) => {
        statusBody += `- ${fix}\n`;
      });
      statusBody += `\n`;
    }

    // Add failure footer if needed
    if (errors.length > 0) {
      statusBody += `Please address these issues and update your pull request.`;
    }

    const commentBody = statusHeader + statusBody;

    // Check if we already posted a comment on this PR
    const comments = await octokit.rest.issues.listComments({
      ...context.repo,
      issue_number: prNumber,
    });

    // Look for an existing comment from the action by checking the header pattern
    const botComment = comments.data.find((comment) =>
      comment.body?.includes(PR_COMMENT_TITLE)
    );

    if (botComment) {
      // Update the existing comment
      await octokit.rest.issues.updateComment({
        ...context.repo,
        comment_id: botComment.id,
        body: commentBody,
      });
      core.info('Updated existing quality check comment on pull request.');
    } else {
      // Post a new comment to the PR
      await octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: prNumber,
        body: commentBody,
      });
      core.info('Posted new quality check comment to pull request.');
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to post comments to PR: ${error.message}`);
    } else {
      core.warning('Failed to post comments to PR: Unknown error');
    }
  }
}

function checkTitle(pullRequest: ContentObject): void {
  const minLength = parseInt(core.getInput('require_title_min_length'), 10);
  if (minLength) {
    if (pullRequest.title.length < minLength) {
      const errorMsg =
        getCustomErrorMessage('title_too_short') ||
        `Pull request title is too short. Minimum length is ${minLength} characters.`;
      errorMessages.push(errorMsg);
    } else {
      successMessages.push(
        `Title meets minimum length requirement (${minLength} characters)`
      );
    }
  }
}

function checkDescription(pullRequest: ContentObject): void {
  const minLength = parseInt(
    core.getInput('require_description_min_length'),
    10
  );
  if (minLength) {
    if (!pullRequest.body || pullRequest.body.length < minLength) {
      const errorMsg =
        getCustomErrorMessage('description_too_short') ||
        `Pull request description is too short. Minimum length is ${minLength} characters.`;
      errorMessages.push(errorMsg);
    } else {
      successMessages.push(
        `Description meets minimum length requirement (${minLength} characters)`
      );
    }
  }
}

function checkLabels(pullRequest: ContentObject): void {
  const labels = pullRequest.labels || [];
  const labelNames = labels.map((l) => l.name);

  // Check if any of the required labels are present
  const anyLabelsSuccess = enforceAnyLabels(labelNames);
  if (anyLabelsSuccess) {
    successMessages.push(anyLabelsSuccess);
  }

  // Check if all of the required labels are present
  const allLabelsSuccess = enforceAllLabels(labelNames);
  if (allLabelsSuccess) {
    successMessages.push(allLabelsSuccess);
  }

  // Check if any banned labels are present
  const bannedLabelsSuccess = enforceBannedLabels(labelNames);
  if (bannedLabelsSuccess) {
    successMessages.push(bannedLabelsSuccess);
  }
}

function checkIssueType(pullRequest: ContentObject): void {
  const requiredIssueTypes = getInputArray('required_issue_types');
  if (requiredIssueTypes.length === 0) {
    return; // No issue type requirements
  }

  const title = pullRequest.title || '';
  const body = pullRequest.body || '';

  // Check if any of the required issue types are in the title or body
  // Format examples: "feat: add new feature", "fix(scope): fix bug"
  const issueTypePattern = new RegExp(
    `^(${requiredIssueTypes.join('|')})(?:\\(\\w+\\))?:\\s.+`
  );

  if (
    !issueTypePattern.test(title) &&
    !body.split('\n').some((line) => issueTypePattern.test(line))
  ) {
    const errorMsg =
      getCustomErrorMessage('invalid_issue_type') ||
      `Pull request must include one of these issue types: ${formatListWithBackticks(requiredIssueTypes)}. Format should be "type: description" or "type(scope): description".`;
    errorMessages.push(errorMsg);
  } else {
    successMessages.push(
      `Includes a valid issue type (${formatListWithBackticks(requiredIssueTypes)})`
    );
  }
}

function enforceAnyLabels(labels: string[]): string | void {
  const requiredLabelsAny = getInputArray('required_labels_any');
  if (requiredLabelsAny.length === 0) {
    return; // No requirements to check
  }

  if (
    !requiredLabelsAny.some((requiredLabel) => labels.includes(requiredLabel))
  ) {
    const errorMsg =
      getCustomErrorMessage('missing_any_labels') ||
      `Please select at least one of the required labels for this pull request: ${formatListWithBackticks(requiredLabelsAny)}`;
    errorMessages.push(errorMsg);
  } else {
    return `Has at least one of the required labels: ${formatListWithBackticks(requiredLabelsAny)}`;
  }
}

function enforceAllLabels(labels: string[]): string | void {
  const requiredLabelsAll = getInputArray('required_labels_all');
  if (requiredLabelsAll.length === 0) {
    return; // No requirements to check
  }

  if (
    !requiredLabelsAll.every((requiredLabel) => labels.includes(requiredLabel))
  ) {
    const missingLabels = requiredLabelsAll.filter(
      (label) => !labels.includes(label)
    );
    const errorMsg =
      getCustomErrorMessage('missing_all_labels') ||
      `The following required labels are missing from this pull request: ${formatListWithBackticks(missingLabels)}`;
    errorMessages.push(errorMsg);
  } else {
    return `Has all required labels: ${formatListWithBackticks(requiredLabelsAll)}`;
  }
}

function enforceBannedLabels(labels: string[]): string | void {
  const bannedLabels = getInputArray('banned_labels');
  if (bannedLabels.length === 0) {
    return; // No requirements to check
  }

  const bannedLabel = labels.find((label) => bannedLabels.includes(label));
  if (bannedLabel) {
    const errorMsg =
      getCustomErrorMessage('banned_label') ||
      `The label "${formatListWithBackticks([bannedLabel])}" is not allowed for this pull request.`;
    errorMessages.push(errorMsg);
  } else {
    return `No banned labels detected`;
  }
}

function checkAssignees(pullRequest: ContentObject): void {
  const requireAssignee = core.getInput('require_assignee') === 'true';
  if (requireAssignee) {
    if (!pullRequest.assignees || pullRequest.assignees.length === 0) {
      const errorMsg =
        getCustomErrorMessage('no_assignee') ||
        'At least one assignee is required for this pull request.';
      errorMessages.push(errorMsg);
    } else {
      successMessages.push(
        `Has at least one assignee: ${formatListWithBackticks(pullRequest.assignees.map((a) => a.login))}`
      );
    }
  }
}

function checkDraft(pullRequest: ContentObject): void {
  const enforceDraft = core.getInput('enforce_draft') === 'true';
  if (enforceDraft) {
    if (pullRequest.draft) {
      const errorMsg =
        getCustomErrorMessage('is_draft') ||
        'Draft pull requests are not allowed. Please mark as ready for review.';
      errorMessages.push(errorMsg);
    } else {
      successMessages.push('Pull request is not in draft state');
    }
  }
}

function checkMilestone(pullRequest: ContentObject): void {
  const requireMilestone = core.getInput('require_milestone') === 'true';
  if (requireMilestone) {
    if (!pullRequest.milestone) {
      const errorMsg =
        getCustomErrorMessage('no_milestone') ||
        'Pull request must be associated with a milestone.';
      errorMessages.push(errorMsg);
    } else {
      successMessages.push(`Has a milestone: ${pullRequest.milestone.title}`);
    }
  }
}

function getInputArray(name: string): string[] {
  const rawInput = core.getInput(name, { required: false });
  return rawInput ? rawInput.split(',').map((item) => item.trim()) : [];
}

function getCustomErrorMessage(key: string): string | null {
  try {
    const customMessages: CustomErrorMessages = JSON.parse(
      core.getInput('custom_error_messages') || '{}'
    );
    return customMessages[key] || null;
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to parse custom error messages: ${error.message}`);
    }
    return null;
  }
}

function formatListWithBackticks(items: string[]): string {
  return `\`${items.join('`, `')}\``;
}

// ============================================================================
// Auto-labeling Functions
// ============================================================================

async function getChangedFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  prNumber: number
): Promise<ChangedFile[]> {
  try {
    const files: ChangedFile[] = [];
    let page = 1;

    // Paginate through all files with safety limit
    while (files.length < MAX_CHANGED_FILES) {
      const response = await octokit.rest.pulls.listFiles({
        ...github.context.repo,
        pull_number: prNumber,
        per_page: 100,
        page: page,
      });

      if (response.data.length === 0) break;

      files.push(...(response.data as ChangedFile[]));
      if (response.data.length < 100) break;
      page++;
    }

    return files.slice(0, MAX_CHANGED_FILES);
  } catch (error) {
    core.warning(`Failed to get changed files: ${error}`);
    return [];
  }
}

async function performAutoLabeling(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject,
  changedFiles: ChangedFile[]
): Promise<void> {
  const autoLabelEnabled = core.getInput('auto_label') === 'true';
  const autoLabelTypeEnabled = core.getInput('auto_label_type') === 'true';

  if (!autoLabelEnabled && !autoLabelTypeEnabled) {
    return;
  }

  const labelsToAdd: Set<string> = new Set();
  const currentLabels = (pullRequest.labels || []).map((l) => l.name);

  // Built-in rules based on file paths (only if auto_label is enabled)
  const builtInRules: AutoLabelRule[] = autoLabelEnabled
    ? [
        {
          label: 'area/docs',
          paths: ['docs/', 'README', '.md', 'CONTRIBUTING', 'LICENSE'],
        },
        {
          label: 'area/ci',
          paths: ['.github/', 'Jenkinsfile', '.travis', '.circleci'],
        },
        {
          label: 'area/tests',
          paths: ['test/', 'tests/', '__tests__/', 'spec/', '.test.', '.spec.'],
        },
        {
          label: 'area/config',
          paths: ['.json', '.yaml', '.yml', '.toml', '.ini', '.env'],
        },
        {
          label: 'kind/dependencies',
          paths: [
            'package-lock.json',
            'yarn.lock',
            'go.sum',
            'Cargo.lock',
            'requirements.txt',
            'Gemfile.lock',
          ],
        },
      ]
    : [];

  // Apply path-based rules
  for (const rule of builtInRules) {
    for (const file of changedFiles) {
      if (rule.paths.some((path) => file.filename.includes(path))) {
        labelsToAdd.add(sanitizeString(rule.label, MAX_LABEL_NAME_LENGTH));
        break;
      }
    }
  }

  // Conventional commit type-based labeling
  if (autoLabelTypeEnabled) {
    const typeLabel = getTypeLabelFromTitle(pullRequest.title);
    if (typeLabel) {
      labelsToAdd.add(typeLabel);
    }
  }

  // Filter out labels that already exist
  const newLabels = Array.from(labelsToAdd).filter(
    (label) => !currentLabels.includes(label)
  );

  if (newLabels.length > 0 && pullRequest.number) {
    try {
      await octokit.rest.issues.addLabels({
        ...github.context.repo,
        issue_number: pullRequest.number,
        labels: newLabels,
      });
      autoAppliedLabels.push(...newLabels);
      core.info(`Auto-applied labels: ${newLabels.join(', ')}`);
    } catch (error) {
      core.warning(`Failed to apply labels: ${error}`);
    }
  }
}

function getTypeLabelFromTitle(title: string): string | null {
  const conventionalCommitRegex = /^(\w+)(?:\([^)]+\))?!?:/;
  const match = title.match(conventionalCommitRegex);
  if (match && match[1]) {
    const type = match[1].toLowerCase();
    const typeToLabel: Record<string, string> = {
      feat: 'kind/feature',
      fix: 'kind/bug',
      docs: 'kind/docs',
      style: 'kind/style',
      refactor: 'kind/refactor',
      perf: 'kind/performance',
      test: 'kind/test',
      build: 'kind/build',
      ci: 'kind/ci',
      chore: 'kind/chore',
      revert: 'kind/revert',
      security: 'kind/security',
      deps: 'kind/dependencies',
    };
    return typeToLabel[type] ?? null;
  }
  return null;
}

// ============================================================================
// Native GitHub Type / Priority Fields
// ============================================================================

interface NativeFields {
  type: string | null;
  /** Single-select field values, keyed by field name (e.g. "Priority" -> "P1"). */
  singleSelects: Map<string, string>;
}

/** One page of the `fetchNativeFields` GraphQL response. */
interface NativeFieldsQuery {
  repository?: {
    issue?: {
      issueType?: { name?: string } | null;
      issueFieldValues?: {
        pageInfo?: {
          hasNextPage?: boolean | null;
          endCursor?: string | null;
        } | null;
        nodes?: Array<{
          __typename?: string;
          name?: string | null;
          field?: { name?: string | null } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

/**
 * Reads GitHub's *native* issue type and issue field values.
 *
 * These replace the older convention of encoding type and priority in labels, so a
 * repository using them no longer needs `kind/*` or `priority/*` labels to carry the
 * same information.
 *
 * Only available over GraphQL, and only on issues: the `PullRequest` GraphQL type
 * exposes neither `issueType` nor `issueFieldValues`. Returns null when the data cannot
 * be read, which callers treat as "cannot evaluate" rather than "requirement not met" —
 * failing a PR because a token lacked a scope would be a false positive.
 */
async function fetchNativeFields(
  octokit: ReturnType<typeof github.getOctokit>,
  issueNumber: number
): Promise<NativeFields | null> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          issueType { name }
          issueFieldValues(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on IssueFieldSingleSelectValue {
                name
                field {
                  ... on IssueFieldSingleSelect { name }
                }
              }
            }
          }
        }
      }
    }`;

  try {
    const singleSelects = new Map<string, string>();
    let type: string | null = null;
    let after: string | null = null;

    // Paged, because a field that exists but sits past the page read is
    // indistinguishable from one that was never set — and the caller reads a
    // missing field as "requirement not met". One page covers every issue in
    // practice; the cap only bounds a runaway, and reaching it returns null
    // ("cannot evaluate") rather than a map that is quietly incomplete.
    for (let page = 0; page < MAX_FIELD_VALUE_PAGES; page++) {
      // Annotated rather than inferred: `after` is assigned from this response
      // and passed back into the next request, and an inferred `result` would
      // make that loop-carried cursor circular (TS7022).
      const result: NativeFieldsQuery = await octokit.graphql<NativeFieldsQuery>(
        query,
        {
          ...github.context.repo,
          number: issueNumber,
          after,
        }
      );

      const issue = result?.repository?.issue;
      if (!issue) {
        return null;
      }
      type = issue.issueType?.name ?? null;

      for (const node of issue.issueFieldValues?.nodes ?? []) {
        const fieldName = node?.field?.name;
        const optionName = node?.name;
        if (fieldName && optionName) {
          singleSelects.set(fieldName.toLowerCase(), optionName);
        }
      }

      const pageInfo = issue.issueFieldValues?.pageInfo;
      if (!pageInfo?.hasNextPage) {
        return { type, singleSelects };
      }
      if (!pageInfo.endCursor) {
        // More pages, but nothing to page with: the same unknown as a failed read.
        core.warning(
          'Issue field values report another page but no cursor to fetch it; ' +
            'skipping the native type/priority checks rather than judging a partial read.'
        );
        return null;
      }
      after = pageInfo.endCursor;
    }

    core.warning(
      `Issue field values did not end within ${MAX_FIELD_VALUE_PAGES} pages; ` +
        'skipping the native type/priority checks rather than judging a partial read.'
    );
    return null;
  } catch (error) {
    core.warning(
      `Could not read native type/priority fields: ${error}. ` +
        'These checks need a token with `read:project`/issue read access on a repository ' +
        'whose organization has issue types configured; skipping them rather than failing.'
    );
    return null;
  }
}

async function checkNativeFields(
  octokit: ReturnType<typeof github.getOctokit>,
  issueNumber: number,
  isIssue: boolean
): Promise<void> {
  const requireType = core.getInput('require_issue_type') === 'true';
  const allowedTypes = getInputArray('allowed_issue_types');
  const priorityForTypes = getInputArray('require_priority_for_types');
  const priorityFieldName = core.getInput('priority_field_name') || 'Priority';

  if (
    !requireType &&
    allowedTypes.length === 0 &&
    priorityForTypes.length === 0
  ) {
    return; // Feature not enabled
  }

  // Pull requests have no native type or field values — enforcing them here would fail
  // every PR for a property GitHub gives it no way to set. Say so once, clearly, rather
  // than failing or silently doing nothing.
  if (!isIssue) {
    core.info(
      'Skipping native type/priority checks: GitHub exposes these fields on issues only, not pull requests.'
    );
    return;
  }

  const fields = await fetchNativeFields(octokit, issueNumber);
  if (!fields) {
    return; // Already warned; do not fail on unreadable data
  }

  // --- Type -------------------------------------------------------------------
  if (requireType && !fields.type) {
    errorMessages.push(
      getCustomErrorMessage('no_issue_type') ||
        'This issue needs a type. Set it with the **Type** field in the sidebar.'
    );
  } else if (fields.type) {
    if (
      allowedTypes.length > 0 &&
      !allowedTypes.some((t) => t.toLowerCase() === fields.type?.toLowerCase())
    ) {
      errorMessages.push(
        getCustomErrorMessage('invalid_native_issue_type') ||
          `Issue type \`${fields.type}\` is not one of the allowed types: ${formatListWithBackticks(allowedTypes)}.`
      );
    } else {
      successMessages.push(`Has issue type: \`${fields.type}\``);
    }
  }

  // --- Priority ---------------------------------------------------------------
  // Only required for the configured types (typically bugs), because triage urgency is
  // meaningful for a defect and mostly noise for a chore.
  if (priorityForTypes.length === 0 || !fields.type) {
    return;
  }
  const needsPriority = priorityForTypes.some(
    (t) => t.toLowerCase() === fields.type?.toLowerCase()
  );
  if (!needsPriority) {
    return;
  }

  const priority = fields.singleSelects.get(priorityFieldName.toLowerCase());
  if (!priority) {
    errorMessages.push(
      getCustomErrorMessage('no_priority') ||
        `A \`${fields.type}\` issue needs a **${priorityFieldName}**. Set the ${priorityFieldName} field in the sidebar.`
    );
  } else {
    successMessages.push(`Has ${priorityFieldName}: \`${priority}\``);
  }
}

// ============================================================================
// Auto-assign Functions
// ============================================================================

/**
 * Assigns the PR author and/or a configured user list, when the PR has no assignees.
 * Returns true if assignees were actually added, so the caller knows the PR's assignee
 * list is now stale and must be re-read before `require_assignee` is evaluated.
 */
async function performAutoAssign(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject
): Promise<boolean> {
  const autoAssignees = getInputArray('auto_assign_users');
  const assignAuthor = core.getInput('auto_assign_author') === 'true';
  const autoAssignEnabled = core.getInput('auto_assign') === 'true';

  // `auto_assign_author` and `auto_assign_users` each enable assignment on their own.
  // They used to be gated behind `auto_assign`, which made the documented quick-start
  // config (`auto_assign_author: 'true'` with `auto_assign` left at its `false` default)
  // silently do nothing — and then fail the PR under `require_assignee` for having no
  // assignee the action was asked to add. `auto_assign` remains supported as the
  // umbrella switch so existing configs keep working.
  const shouldAssign =
    autoAssignEnabled || assignAuthor || autoAssignees.length > 0;
  if (!shouldAssign || !pullRequest.number) {
    return false;
  }

  // Check if already has assignees
  if (pullRequest.assignees && pullRequest.assignees.length > 0) {
    return false;
  }

  const assigneesToAdd: string[] = [];

  // Assign the PR author
  if (assignAuthor && pullRequest.user?.login) {
    assigneesToAdd.push(pullRequest.user.login);
  }

  // Add configured auto-assignees
  assigneesToAdd.push(...autoAssignees);

  if (assigneesToAdd.length > 0) {
    try {
      const response = await octokit.rest.issues.addAssignees({
        ...github.context.repo,
        issue_number: pullRequest.number,
        assignees: [...new Set(assigneesToAdd)],
      });
      // GitHub silently drops assignees it will not accept — App/bot accounts such as
      // dependabot[bot], and users without repository access. The request still returns
      // 201, so the only way to know whether anything was actually assigned is to read
      // the assignee list back off the response.
      const assigned = (response.data.assignees ?? []).map((a) => a.login);
      if (assigned.length === 0) {
        core.warning(
          `Auto-assign was requested for ${formatListWithBackticks(assigneesToAdd)}, but GitHub accepted none of them. ` +
            'This is expected for App/bot authors (for example `dependabot[bot]`), which cannot be assigned, ' +
            'and for users without access to this repository.'
        );
        return false;
      }
      core.info(`Auto-assigned: ${assigned.join(', ')}`);
      successMessages.push(
        `Auto-assigned: ${formatListWithBackticks(assigned)}`
      );
      return true;
    } catch (error) {
      core.warning(`Failed to auto-assign: ${error}`);
    }
  }

  return false;
}

// ============================================================================
// Label Category Functions
// ============================================================================

function checkLabelCategories(pullRequest: ContentObject): void {
  const requiredPrefixes = getInputArray('required_label_prefixes');
  if (requiredPrefixes.length === 0) {
    return;
  }

  const labels = (pullRequest.labels || []).map((l) => l.name);

  for (const prefixInput of requiredPrefixes) {
    const prefix = prefixInput.endsWith('/') ? prefixInput : `${prefixInput}/`;
    const hasLabelFromCategory = labels.some((label) =>
      label.startsWith(prefix)
    );

    if (!hasLabelFromCategory) {
      const errorMsg =
        getCustomErrorMessage(
          `missing_category_${prefixInput.replace('/', '')}`
        ) || `Missing required label from category \`${prefix}\`.`;
      errorMessages.push(errorMsg);
      suggestedFixes.push(
        `Add a label with prefix \`${prefix}\` (e.g., ${prefix}example)`
      );
    } else {
      successMessages.push(`Has a label from required category \`${prefix}\``);
    }
  }
}

// ============================================================================
// Branch Naming Check
// ============================================================================

function checkBranchNaming(pullRequest: ContentObject): void {
  const branchPattern = core.getInput('branch_name_pattern');
  if (!branchPattern || !pullRequest.head?.ref) {
    return;
  }

  const branchName = pullRequest.head.ref;
  const regex = new RegExp(branchPattern);

  if (!regex.test(branchName)) {
    const errorMsg =
      getCustomErrorMessage('invalid_branch_name') ||
      `Branch name \`${branchName}\` does not match required pattern: \`${branchPattern}\``;
    errorMessages.push(errorMsg);
    suggestedFixes.push(
      `Rename your branch to match the pattern: \`${branchPattern}\``
    );
  } else {
    successMessages.push(`Branch name matches required pattern`);
  }
}

run();

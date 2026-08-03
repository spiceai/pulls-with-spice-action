import * as core from '@actions/core';
import * as github from '@actions/github';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, Output } from 'ai';
import { z } from 'zod';

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

// Schema for AI label analysis response using structured outputs
const AILabelAnalysisSchema = z.object({
  labelsToAdd: z
    .array(z.string())
    .describe(
      'Labels that should be added to the PR from the available labels list',
    ),
  labelsToRemove: z
    .array(z.string())
    .describe(
      'Labels currently applied that should be removed as they are incorrect or not applicable',
    ),
  reasoning: z.string().describe('Brief explanation of the label changes'),
});

type AILabelAnalysis = z.infer<typeof AILabelAnalysisSchema>;

/**
 * `ai_model` is passed to the endpoint verbatim, and on Spice Cloud a model is named by
 * whatever the spicepod calls it — `openai` is the conventional name for the default
 * OpenAI model. Callers going direct to OpenAI set a real model id instead.
 */
const DEFAULT_AI_MODEL = 'openai';

const AI_LABELING_SYSTEM_PROMPT =
  'You review the labels on GitHub pull requests and correct them.';

const PR_COMMENT_TITLE = 'Pull with Spice';

// Security: Maximum lengths to prevent DoS via extremely long inputs
const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 65536;
const MAX_LABEL_NAME_LENGTH = 100;
const MAX_LABELS_COUNT = 100;
const MAX_CHANGED_FILES = 3000;
/**
 * The repository's whole label set is listed in the AI prompt, so it is bounded like
 * every other paginated read here. No real repository comes close.
 */
const MAX_REPOSITORY_LABELS = 1000;
/** Items per page for the REST list endpoints, which cap `per_page` at 100. */
const REST_PAGE_SIZE = 100;
/** Pages of `issueFieldValues` read before giving up — see `fetchNativeFields`. */
const MAX_FIELD_VALUE_PAGES = 10;
/**
 * The model's reasoning is quoted verbatim into the PR comment, which GitHub caps at
 * 65536 characters in total. Keep it to a paragraph so it cannot crowd out the checks.
 */
const MAX_AI_REASONING_LENGTH = 2000;
/** Changed files listed in the AI prompt. Enough to characterize a PR without paying for the tail. */
const MAX_AI_PROMPT_FILES = 50;
/**
 * The description sent to the model, which gets its own much tighter bound than the
 * 65536 characters the checks tolerate. Choosing labels needs the what and the why, not
 * a template's worth of boilerplate or a pasted stack trace — and at the check limit the
 * body alone would be ~90% of the prompt, billed again on every re-trigger of the run.
 */
const MAX_AI_PROMPT_BODY_LENGTH = 4000;
// Collect errors and success messages
const errorMessages: string[] = [];
const successMessages: string[] = [];
const autoAppliedLabels: string[] = [];
const suggestedFixes: string[] = [];
const aiAnalysisResults: string[] = [];

// ============================================================================
// Input Validation Functions
// ============================================================================

function sanitizeString(input: string | undefined, maxLength: number): string {
  if (!input) return '';
  return input.slice(0, maxLength);
}

/**
 * Whether the account that triggered this run already has write access.
 *
 * The AI pass feeds attacker-controllable text — title, description, branch, filenames —
 * to a model and then applies the labels it names. On a `pull_request` event that is
 * contained, because a fork PR gets no secrets and so no API key. On an `issues` event
 * it is not: issues live in the base repository, so secrets are present and any account
 * can open one, and editing the issue re-fires the run for another attempt. Applying
 * labels needs triage; opening an issue needs nothing. Without this gate the pass hands
 * the lower privilege the higher one.
 *
 * `author_association` comes from the event payload, so this costs no API call. Anything
 * it does not vouch for is refused rather than assumed safe.
 */
function senderCanWrite(): boolean {
  const subject =
    github.context.payload.pull_request ?? github.context.payload.issue;
  const association = (subject as { author_association?: string } | undefined)
    ?.author_association;

  if (
    association &&
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association)
  ) {
    return true;
  }

  core.info(
    `Skipping AI label review: ${github.context.actor || 'the author'} does not have write access ` +
      `(author_association: ${association ?? 'unknown'}). The rule-based labels still apply.`,
  );
  return false;
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
        'This action works on pull requests and issues. Neither was found in the event payload.',
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

    const spiceApiKey = core.getInput('spice_api_key');
    if (spiceApiKey) {
      // Actions masks its own secrets, but the key can also arrive from a variable or a
      // literal. Register it so a provider error that quotes the request cannot print it.
      core.setSecret(spiceApiKey);
    }

    const autoLabelEnabled = core.getInput('auto_label') === 'true';
    const aiAutoLabelEnabled =
      core.getInput('ai_auto_label') === 'true' && spiceApiKey !== '';

    // Both labelling passes read the changed files, so the fetch is gated on whether
    // *any* of them needs file data. Gating it on `auto_label` alone left the AI pass
    // reviewing a pull request whose file list — its strongest signal — was empty.
    let changedFiles: ChangedFile[] = [];
    if (
      octokit &&
      pullRequest.number &&
      !isIssue &&
      (autoLabelEnabled || aiAutoLabelEnabled)
    ) {
      changedFiles = await getChangedFiles(octokit, pullRequest.number);
    }

    // Auto-labeling (runs before validation)
    let labelsChanged = false;
    if (octokit && pullRequest.number) {
      labelsChanged = await performAutoLabeling(
        octokit,
        pullRequest,
        changedFiles,
      );
    }

    // AI label review, refining what the rule-based pass just applied.
    if (
      octokit &&
      pullRequest.number &&
      aiAutoLabelEnabled &&
      senderCanWrite()
    ) {
      const aiChangedLabels = await performAIAutoLabeling(
        octokit,
        pullRequest,
        changedFiles,
        spiceApiKey,
      );
      labelsChanged = labelsChanged || aiChangedLabels;
    }

    // Auto-assign (if enabled)
    let didAutoAssign = false;
    if (octokit && pullRequest.number) {
      didAutoAssign = await performAutoAssign(octokit, pullRequest);
    }

    // Re-read the PR if we changed anything on it, so the checks below evaluate the
    // current state. This keyed off `auto_assign` before, which meant an author
    // assignment made via `auto_assign_author` left `pullRequest.assignees` stale and
    // `checkAssignees` failed a PR the action had just assigned. The labelling passes
    // report whether they wrote anything rather than being inferred from
    // `autoAppliedLabels`, which only ever records *additions* — an AI pass that just
    // removed a label would otherwise leave the checks judging the deleted label.
    const needsRefresh = labelsChanged || didAutoAssign;
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
        `Pull request checks failed (${errorMessages.length}): ${errorMessages.join(' | ')}`,
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
  successes: string[],
): Promise<void> {
  try {
    const token = core.getInput('github_token');
    if (!token) {
      core.warning(
        'No GitHub token provided. Unable to post comments to the PR.',
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
        'Could not find a pull request or issue number in context. Unable to post comments.',
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

    // Add AI analysis section
    if (aiAnalysisResults.length > 0) {
      statusBody += `### 🤖 AI Analysis:\n\n`;
      aiAnalysisResults.forEach((result) => {
        statusBody += `${result}\n`;
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
    const botComment = comments.data.find(
      (comment: { body?: string | null; id: number }) =>
        comment.body?.includes(PR_COMMENT_TITLE),
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
        `Title meets minimum length requirement (${minLength} characters)`,
      );
    }
  }
}

function checkDescription(pullRequest: ContentObject): void {
  const minLength = parseInt(
    core.getInput('require_description_min_length'),
    10,
  );
  if (minLength) {
    if (!pullRequest.body || pullRequest.body.length < minLength) {
      const errorMsg =
        getCustomErrorMessage('description_too_short') ||
        `Pull request description is too short. Minimum length is ${minLength} characters.`;
      errorMessages.push(errorMsg);
    } else {
      successMessages.push(
        `Description meets minimum length requirement (${minLength} characters)`,
      );
    }
  }
}

function checkLabels(pullRequest: ContentObject): void {
  const labelNames = getLabelNames(pullRequest);

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
    `^(${requiredIssueTypes.join('|')})(?:\\(\\w+\\))?:\\s.+`,
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
      `Includes a valid issue type (${formatListWithBackticks(requiredIssueTypes)})`,
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
      (label) => !labels.includes(label),
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
        `Has at least one assignee: ${formatListWithBackticks(pullRequest.assignees.map((a) => a.login))}`,
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
      core.getInput('custom_error_messages') || '{}',
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

function getLabelNames(pullRequest: ContentObject): string[] {
  return (pullRequest.labels || []).map((l) => l.name);
}

// ============================================================================
// Auto-labeling Functions
// ============================================================================

/**
 * Walks a paginated REST endpoint until it serves a short page or `maxItems` is reached.
 * Every paginated read here is bounded, so a misbehaving endpoint degrades to a truncated
 * list rather than looping forever.
 */
async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  maxItems: number,
): Promise<T[]> {
  const items: T[] = [];

  for (let page = 1; items.length < maxItems; page++) {
    const batch = await fetchPage(page);
    if (batch.length === 0) break;
    items.push(...batch);
    if (batch.length < REST_PAGE_SIZE) break;
  }

  return items.slice(0, maxItems);
}

async function getChangedFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  prNumber: number,
): Promise<ChangedFile[]> {
  try {
    return await fetchAllPages<ChangedFile>(async (page) => {
      const response = await octokit.rest.pulls.listFiles({
        ...github.context.repo,
        pull_number: prNumber,
        per_page: REST_PAGE_SIZE,
        page,
      });
      return response.data as ChangedFile[];
    }, MAX_CHANGED_FILES);
  } catch (error) {
    core.warning(`Failed to get changed files: ${error}`);
    return [];
  }
}

async function getRepositoryLabels(
  octokit: ReturnType<typeof github.getOctokit>,
): Promise<string[]> {
  try {
    const labels = await fetchAllPages<{ name: string }>(async (page) => {
      const response = await octokit.rest.issues.listLabelsForRepo({
        ...github.context.repo,
        per_page: REST_PAGE_SIZE,
        page,
      });
      return response.data;
    }, MAX_REPOSITORY_LABELS);

    core.info(`Found ${labels.length} labels in repository`);
    return labels.map((label) => label.name);
  } catch (error) {
    core.warning(`Failed to get repository labels: ${error}`);
    return [];
  }
}

/** Returns true when labels were actually written, so the caller can refresh the PR. */
async function performAutoLabeling(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject,
  changedFiles: ChangedFile[],
): Promise<boolean> {
  const autoLabelEnabled = core.getInput('auto_label') === 'true';
  const autoLabelTypeEnabled = core.getInput('auto_label_type') === 'true';

  if (!autoLabelEnabled && !autoLabelTypeEnabled) {
    return false;
  }

  const labelsToAdd: Set<string> = new Set();
  const currentLabels = getLabelNames(pullRequest);
  const currentKindLabels = currentLabels.filter((label) => isKindLabel(label));
  let pathBasedKindLabel: string | null = null;

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
    const matched = changedFiles.some((file) =>
      rule.paths.some((path) => file.filename.includes(path)),
    );
    if (!matched) {
      continue;
    }

    const sanitizedLabel = sanitizeString(rule.label, MAX_LABEL_NAME_LENGTH);
    if (isKindLabel(sanitizedLabel)) {
      // Keep a single path-based kind label candidate.
      pathBasedKindLabel ??= sanitizedLabel;
    } else {
      labelsToAdd.add(sanitizedLabel);
    }
  }

  // Conventional commit type-based labeling
  let typeBasedKindLabel: string | null = null;
  if (autoLabelTypeEnabled) {
    const typeLabel = getTypeLabelFromTitle(pullRequest.title);
    if (typeLabel) {
      typeBasedKindLabel = typeLabel;
    }
  }

  const preferredKindLabel = typeBasedKindLabel || pathBasedKindLabel;
  if (preferredKindLabel) {
    const { accepted, rejected } = reconcileKindLabels(currentKindLabels, [
      preferredKindLabel,
    ]);
    accepted.forEach((label) => labelsToAdd.add(label));
    if (rejected.length > 0) {
      core.info(
        `Skipping auto-adding kind label "${preferredKindLabel}" because pull request already has kind label(s): ${currentKindLabels.join(', ')}`,
      );
    }
  }

  // Filter out labels that already exist
  const newLabels = Array.from(labelsToAdd).filter(
    (label) => !currentLabels.includes(label),
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
      return true;
    } catch (error) {
      core.warning(`Failed to apply labels: ${error}`);
    }
  }

  return false;
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

function isKindLabel(label: string): boolean {
  return label.startsWith('kind/');
}

/**
 * `kind/` labels are mutually exclusive — an issue carries at most one.
 *
 * Given the kind labels that will still be on the issue once this run's removals land,
 * splits the proposed additions into the ones that may be applied and the ones that must
 * be dropped. A surviving kind label wins over any addition; with none surviving, the
 * first candidate is taken and the rest dropped.
 *
 * Both labelling passes share this so the rule has one definition rather than one per
 * pass. Non-`kind/` candidates are not this function's business and are ignored.
 */
function reconcileKindLabels(
  keptKindLabels: string[],
  candidates: string[],
): { accepted: string[]; rejected: string[] } {
  const kindCandidates = candidates.filter(isKindLabel);

  if (keptKindLabels.length === 0) {
    return {
      accepted: kindCandidates.slice(0, 1),
      rejected: kindCandidates.slice(1),
    };
  }

  return {
    accepted: kindCandidates.filter((label) => keptKindLabels.includes(label)),
    rejected: kindCandidates.filter((label) => !keptKindLabels.includes(label)),
  };
}

// ============================================================================
// AI Auto-labeling Functions (Spice Cloud)
// ============================================================================

/** Returns true when labels were actually written, so the caller can refresh the PR. */
async function performAIAutoLabeling(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject,
  changedFiles: ChangedFile[],
  spiceApiKey: string,
): Promise<boolean> {
  let labelsChanged = false;

  try {
    core.info('Performing AI-powered auto-labeling refinement...');

    // The rule-based pass just ran and its labels are not yet reflected on
    // `pullRequest`. Reviewing the stale list would leave the AI unable to remove a
    // label the rule-based pass had wrongly applied moments earlier — the single case
    // this pass exists to catch.
    const currentLabels = [
      ...new Set([...getLabelNames(pullRequest), ...autoAppliedLabels]),
    ];

    const repoLabels = await getRepositoryLabels(octokit);
    if (repoLabels.length === 0) {
      core.info(
        'No repository labels available; skipping AI label review. (See preceding warnings if the label fetch failed.)',
      );
      return false;
    }

    // Build the prompt for the LLM, including current labels for refinement
    const prompt = buildAILabelingPrompt(
      pullRequest,
      changedFiles,
      repoLabels,
      currentLabels,
    );

    const analysis = await callLabelingModel(spiceApiKey, prompt);

    if (!analysis) {
      aiAnalysisResults.push('AI analysis could not be completed.');
      return false;
    }

    if (analysis.reasoning) {
      aiAnalysisResults.push(`**Reasoning:** ${analysis.reasoning}`);
    }

    // `addLabels` *creates* a label that does not exist yet, so an invented name would
    // silently add it to the repository's label set rather than fail. Only names the
    // prompt actually offered are allowed through.
    const knownLabels = new Set(repoLabels);
    const invented = analysis.labelsToAdd.filter(
      (label) => !knownLabels.has(label),
    );
    if (invented.length > 0) {
      core.warning(
        `Ignoring AI-suggested labels that do not exist in this repository: ${formatListWithBackticks(invented)}`,
      );
    }

    // The model does not know the repository's policy, so it must not be able to break
    // it. Left unguarded it removed the only `kind/` label from a pull request whose
    // config required one, and the checks a few lines later then failed that pull
    // request for a violation this action had just created.
    const protectedLabels = getPolicyProtectedLabels(currentLabels);
    const bannedLabels = new Set(getInputArray('banned_labels'));

    const suggestedLabelsToAdd = analysis.labelsToAdd.filter(
      (label) =>
        knownLabels.has(label) &&
        !currentLabels.includes(label) &&
        !bannedLabels.has(label),
    );
    const refusedAdds = analysis.labelsToAdd.filter((label) =>
      bannedLabels.has(label),
    );
    if (refusedAdds.length > 0) {
      core.warning(
        `Ignoring AI-suggested labels that \`banned_labels\` forbids: ${formatListWithBackticks(refusedAdds)}`,
      );
    }

    const labelsToRemove = analysis.labelsToRemove.filter(
      (label) => currentLabels.includes(label) && !protectedLabels.has(label),
    );
    const refusedRemovals = analysis.labelsToRemove.filter((label) =>
      protectedLabels.has(label),
    );
    if (refusedRemovals.length > 0) {
      core.warning(
        `Keeping ${formatListWithBackticks(refusedRemovals)} despite the AI suggesting removal: required by this workflow's label policy.`,
      );
    }

    // Keep `kind/` mutually exclusive, the same rule — and now the same code — the
    // rule-based pass follows. Any kind label the AI is not removing survives, so it
    // wins over an addition.
    const survivingKindLabels = currentLabels.filter(
      (label) => isKindLabel(label) && !labelsToRemove.includes(label),
    );
    const { rejected: rejectedKindLabels } = reconcileKindLabels(
      survivingKindLabels,
      suggestedLabelsToAdd,
    );
    const labelsToAdd = suggestedLabelsToAdd.filter(
      (label) => !rejectedKindLabels.includes(label),
    );
    if (rejectedKindLabels.length > 0) {
      const survivor = survivingKindLabels[0];
      core.info(
        `Dropping AI kind label(s) ${formatListWithBackticks(rejectedKindLabels)} to keep a single kind label` +
          (survivor ? `; keeping \`${survivor}\`` : ''),
      );
    }

    if (labelsToRemove.length > 0 && pullRequest.number) {
      // Removals go one call at a time and any of them can fail, so the report is built
      // from what GitHub actually accepted. Listing the requested set instead told
      // readers a label was gone while it was still on the pull request.
      const removed: string[] = [];
      for (const label of labelsToRemove) {
        try {
          await octokit.rest.issues.removeLabel({
            ...github.context.repo,
            issue_number: pullRequest.number,
            name: label,
          });
          removed.push(label);
          labelsChanged = true;
          core.info(`AI removed label: ${label}`);
        } catch (error) {
          core.warning(`Failed to remove label ${label}: ${error}`);
        }
      }
      if (removed.length > 0) {
        aiAnalysisResults.push(
          `**Labels removed by AI:** ${formatListWithBackticks(removed)}`,
        );
      }
    }

    if (labelsToAdd.length > 0 && pullRequest.number) {
      try {
        await octokit.rest.issues.addLabels({
          ...github.context.repo,
          issue_number: pullRequest.number,
          labels: labelsToAdd,
        });
        labelsChanged = true;
        // Plain label names: `autoAppliedLabels` is also the list shown in the PR
        // comment, so it must not carry display decoration.
        autoAppliedLabels.push(...labelsToAdd);
        aiAnalysisResults.push(
          `**Labels added by AI:** ${formatListWithBackticks(labelsToAdd)}`,
        );
        core.info(`AI added labels: ${labelsToAdd.join(', ')}`);
      } catch (error) {
        core.warning(`Failed to apply AI-suggested labels: ${error}`);
      }
    }

    if (labelsToAdd.length === 0 && labelsToRemove.length === 0) {
      aiAnalysisResults.push(
        'AI analysis confirmed current labels are appropriate.',
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`AI auto-labeling failed: ${error.message}`);
    } else {
      core.warning('AI auto-labeling failed with unknown error');
    }
  }

  return labelsChanged;
}

/**
 * The labels this run must not end without, given the configured checks.
 *
 * The model is told the policy, but being told is not being bound by it: it removed the
 * only `kind/` label from a pull request whose config required one, and the checks then
 * failed that pull request for a violation this action had just created. A label is
 * protected when it is the last thing satisfying a requirement — removing a duplicate is
 * still allowed.
 */
function getPolicyProtectedLabels(currentLabels: string[]): Set<string> {
  const protectedLabels = new Set<string>();

  // Every label in `required_labels_all` is load-bearing on its own.
  for (const label of getInputArray('required_labels_all')) {
    if (currentLabels.includes(label)) {
      protectedLabels.add(label);
    }
  }

  // `required_labels_any` and each `required_label_prefixes` category are satisfied by
  // one member, so only protect that member when it is the last one standing.
  const requiredAny = getInputArray('required_labels_any');
  const satisfyingAny = currentLabels.filter((label) =>
    requiredAny.includes(label),
  );
  if (satisfyingAny.length === 1) {
    protectedLabels.add(satisfyingAny[0] as string);
  }

  for (const prefixInput of getInputArray('required_label_prefixes')) {
    const prefix = prefixInput.endsWith('/') ? prefixInput : `${prefixInput}/`;
    const satisfying = currentLabels.filter((label) =>
      label.startsWith(prefix),
    );
    if (satisfying.length === 1) {
      protectedLabels.add(satisfying[0] as string);
    }
  }

  return protectedLabels;
}

/**
 * Describes the configured label policy to the model.
 *
 * Without this the model was guessing at rules it was then judged against — it read the
 * repository's `enhancement` label as satisfying the `kind/` category, dropped
 * `kind/feature` as the redundant one, and left the pull request failing.
 */
function describeLabelPolicy(): string {
  const rules: string[] = [];

  const requiredPrefixes = getInputArray('required_label_prefixes');
  for (const prefixInput of requiredPrefixes) {
    const prefix = prefixInput.endsWith('/') ? prefixInput : `${prefixInput}/`;
    rules.push(
      `- This pull request MUST keep at least one label whose name literally begins with \`${prefix}\`. Only that exact prefix counts — a label that merely means something similar does not.`,
    );
  }

  const requiredAny = getInputArray('required_labels_any');
  if (requiredAny.length > 0) {
    rules.push(
      `- It must keep at least one of: ${formatListWithBackticks(requiredAny)}.`,
    );
  }

  const requiredAll = getInputArray('required_labels_all');
  if (requiredAll.length > 0) {
    rules.push(
      `- It must keep all of: ${formatListWithBackticks(requiredAll)}.`,
    );
  }

  const banned = getInputArray('banned_labels');
  if (banned.length > 0) {
    rules.push(`- Never suggest: ${formatListWithBackticks(banned)}.`);
  }

  return rules.length > 0
    ? `## Label Policy (enforced after your response)\nThese rules are checked immediately after your labels are applied. Violating one fails the pull request.\n${rules.join('\n')}\n`
    : '';
}

function buildAILabelingPrompt(
  pullRequest: ContentObject,
  changedFiles: ChangedFile[],
  repoLabels: string[],
  currentLabels: string[],
): string {
  const filesSummary = changedFiles
    .slice(0, MAX_AI_PROMPT_FILES)
    .map((f) => `- ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join('\n');
  const omittedFiles = Math.max(0, changedFiles.length - MAX_AI_PROMPT_FILES);
  const body = sanitizeString(pullRequest.body, MAX_AI_PROMPT_BODY_LENGTH);

  return `Review and refine the labels on this GitHub pull request.

## Pull Request Details

**Title:** ${pullRequest.title}

**Description:**
${body || 'No description provided'}

**Branch:** ${pullRequest.head?.ref || 'unknown'} -> ${pullRequest.base?.ref || 'unknown'}

**Changed Files (${changedFiles.length} total):**
${filesSummary}
${omittedFiles > 0 ? `\n... and ${omittedFiles} more files` : ''}

## Currently Applied Labels
${currentLabels.length > 0 ? currentLabels.map((l) => `- ${l}`).join('\n') : 'No labels currently applied'}

## Available Labels in Repository
${repoLabels.map((l) => `- ${l}`).join('\n')}

${describeLabelPolicy()}
## Instructions
Review the currently applied labels and suggest improvements:
1. Identify any labels that are incorrect or don't apply to this PR (add to labelsToRemove)
2. Identify any missing labels that should be added (add to labelsToAdd)
3. Consider the type of change and the areas affected
4. Keep at most one label whose name literally begins with \`kind/\`. Labels without that
   prefix are never \`kind/\` labels, however similar their meaning — a repository may
   well carry both \`enhancement\` and \`kind/feature\`, and they do not conflict.

Judge the pull request by what it is *for*, not by the incidental churn it drags along.
A feature that happens to touch a lock file is still a feature; a title beginning
\`feat:\` or \`fix:\` is a strong statement of intent by the author.

Be conservative - only suggest changes you are confident about. If the current labels are appropriate, return empty arrays.`;
}

/** Spice Cloud HTTP data endpoints, which serve the OpenAI-compatible API. */
const SPICE_CLOUD_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://us-east-1-prod-aws-data.spiceai.io/v1',
  'us-west-2': 'https://us-west-2-prod-aws-data.spiceai.io/v1',
};
const DEFAULT_SPICE_CLOUD_REGION = 'us-east-1';

function getSpiceCloudBaseUrl(region: string): string {
  const endpoint = SPICE_CLOUD_ENDPOINTS[region];
  if (endpoint) {
    return endpoint;
  }

  core.warning(
    `Unknown Spice Cloud region "${region}". Known regions: ${formatListWithBackticks(
      Object.keys(SPICE_CLOUD_ENDPOINTS),
    )}. Falling back to ${DEFAULT_SPICE_CLOUD_REGION}.`,
  );
  return SPICE_CLOUD_ENDPOINTS[DEFAULT_SPICE_CLOUD_REGION] as string;
}

function isOpenAIKey(apiKey: string): boolean {
  // OpenAI API keys start with 'sk-' (including service account keys 'sk-svcacct-')
  return apiKey.startsWith('sk-');
}

/**
 * Bounds a model-supplied label list. Nothing about the response is trusted: the model
 * is free to answer with a thousand labels or a label built from a megabyte of text, and
 * each entry becomes an API call and a line in the PR comment.
 */
function sanitizeLabelList(labels: string[]): string[] {
  return labels
    .map((label) => sanitizeString(label, MAX_LABEL_NAME_LENGTH).trim())
    .filter((label) => label.length > 0)
    .slice(0, MAX_LABELS_COUNT);
}

function sanitizeAILabelAnalysis(analysis: AILabelAnalysis): AILabelAnalysis {
  return {
    labelsToAdd: sanitizeLabelList(analysis.labelsToAdd),
    labelsToRemove: sanitizeLabelList(analysis.labelsToRemove),
    reasoning: sanitizeString(analysis.reasoning, MAX_AI_REASONING_LENGTH),
  };
}

function parseAILabelAnalysisFromText(text: string): AILabelAnalysis | null {
  const trimmed = text.trim();

  // Models often wrap the JSON in prose or a code fence, so fall back to the span
  // between the outermost braces when the response as a whole does not parse. When the
  // response *is* bare JSON that span is the response, and there is only one attempt.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const extracted =
    firstBrace >= 0 && lastBrace > firstBrace
      ? trimmed.slice(firstBrace, lastBrace + 1)
      : null;
  const candidates =
    extracted && extracted !== trimmed ? [trimmed, extracted] : [trimmed];

  for (const candidate of candidates) {
    try {
      const validated = AILabelAnalysisSchema.safeParse(JSON.parse(candidate));
      if (validated.success) {
        return validated.data;
      }
    } catch {
      // Not JSON; try the next parsing candidate.
    }
  }

  return null;
}

/**
 * Describes a failed model call without reproducing the request that caused it.
 *
 * AI SDK errors carry the outgoing request on `requestBodyValues`/`responseHeaders`, and
 * the provider is authenticated with the caller's API key — serializing the whole error,
 * as this did while the Spice endpoint was being brought up, prints that key into a log
 * `core.setSecret` never saw and cannot mask.
 */
function describeModelError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const status =
    APICallError.isInstance(error) && error.statusCode
      ? ` (status ${error.statusCode})`
      : '';
  return `${error.message || error.name}${status}`;
}

/**
 * Asks the configured model to review the PR's labels.
 *
 * Returns null on any failure — an unreachable endpoint, a refusal, a reply that is not
 * the JSON we asked for. Labelling is an assist, so a bad answer must degrade to the
 * rule-based labels rather than fail the PR.
 */
async function callLabelingModel(
  apiKey: string,
  prompt: string,
): Promise<AILabelAnalysis | null> {
  const configuredModel = core.getInput('ai_model');
  const useOpenAI = isOpenAIKey(apiKey);

  // `ai_model` defaults to a Spice Cloud model name, which OpenAI would reject. Rather
  // than let the default turn into a 404 that reads as "the AI pass is broken", say
  // plainly that this combination needs a real model id.
  if (useOpenAI && !configuredModel) {
    core.warning(
      `Skipping AI label review: \`spice_api_key\` looks like an OpenAI key, so \`ai_model\` must name an OpenAI model (for example \`gpt-5.4\`). ` +
        `The default \`${DEFAULT_AI_MODEL}\` is a Spice Cloud model name and OpenAI does not serve it.`,
    );
    return null;
  }

  const modelName = configuredModel || DEFAULT_AI_MODEL;

  try {
    // An `sk-` key is an OpenAI key, not a Spice Cloud one. Sending it to Spice Cloud
    // would just 401, so honour it directly and skip the region entirely.
    const analysis = useOpenAI
      ? await callOpenAIModel(apiKey, modelName, prompt)
      : await callSpiceCloudModel(apiKey, modelName, prompt);

    return analysis ? sanitizeAILabelAnalysis(analysis) : null;
  } catch (error) {
    core.warning(
      `Model "${modelName}" could not be reached: ${describeModelError(error)}`,
    );
    return null;
  }
}

/**
 * The native OpenAI provider supports strict structured output, so the schema is
 * enforced by the API rather than parsed back out of prose.
 */
async function callOpenAIModel(
  apiKey: string,
  modelName: string,
  prompt: string,
): Promise<AILabelAnalysis | null> {
  core.info(`Calling OpenAI directly with model "${modelName}"`);

  const { output } = await generateText({
    model: createOpenAI({ apiKey })(modelName),
    output: Output.object({ schema: AILabelAnalysisSchema }),
    system: AI_LABELING_SYSTEM_PROMPT,
    prompt,
  });

  return output ?? null;
}

/**
 * Spice Cloud proxies arbitrary models and they do not all honour `response_format`, so
 * ask for JSON in the prompt and validate what comes back instead of relying on the API
 * to enforce the schema.
 */
async function callSpiceCloudModel(
  apiKey: string,
  modelName: string,
  prompt: string,
): Promise<AILabelAnalysis | null> {
  const region =
    core.getInput('spice_cloud_region') || DEFAULT_SPICE_CLOUD_REGION;
  const baseURL = getSpiceCloudBaseUrl(region);
  core.info(
    `Calling Spice Cloud model "${modelName}" in ${region} (${baseURL})`,
  );

  const provider = createOpenAICompatible({
    name: 'spice-cloud',
    apiKey,
    baseURL,
    headers: { 'X-API-Key': apiKey },
  });

  const { text } = await generateText({
    model: provider(modelName),
    system: `${AI_LABELING_SYSTEM_PROMPT} Return only valid JSON of the form {"labelsToAdd": string[], "labelsToRemove": string[], "reasoning": string}.`,
    prompt,
  });

  const parsed = parseAILabelAnalysisFromText(text);
  if (!parsed) {
    core.warning(
      `Model "${modelName}" did not return the expected JSON; leaving labels unchanged.`,
    );
  }

  return parsed;
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
  issueNumber: number,
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
      const result: NativeFieldsQuery =
        await octokit.graphql<NativeFieldsQuery>(query, {
          ...github.context.repo,
          number: issueNumber,
          after,
        });

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
            'skipping the native type/priority checks rather than judging a partial read.',
        );
        return null;
      }
      after = pageInfo.endCursor;
    }

    core.warning(
      `Issue field values did not end within ${MAX_FIELD_VALUE_PAGES} pages; ` +
        'skipping the native type/priority checks rather than judging a partial read.',
    );
    return null;
  } catch (error) {
    core.warning(
      `Could not read native type/priority fields: ${error}. ` +
        'These checks need a token with `read:project`/issue read access on a repository ' +
        'whose organization has issue types configured; skipping them rather than failing.',
    );
    return null;
  }
}

async function checkNativeFields(
  octokit: ReturnType<typeof github.getOctokit>,
  issueNumber: number,
  isIssue: boolean,
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
      'Skipping native type/priority checks: GitHub exposes these fields on issues only, not pull requests.',
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
        'This issue needs a type. Set it with the **Type** field in the sidebar.',
    );
  } else if (fields.type) {
    if (
      allowedTypes.length > 0 &&
      !allowedTypes.some((t) => t.toLowerCase() === fields.type?.toLowerCase())
    ) {
      errorMessages.push(
        getCustomErrorMessage('invalid_native_issue_type') ||
          `Issue type \`${fields.type}\` is not one of the allowed types: ${formatListWithBackticks(allowedTypes)}.`,
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
    (t) => t.toLowerCase() === fields.type?.toLowerCase(),
  );
  if (!needsPriority) {
    return;
  }

  const priority = fields.singleSelects.get(priorityFieldName.toLowerCase());
  if (!priority) {
    errorMessages.push(
      getCustomErrorMessage('no_priority') ||
        `A \`${fields.type}\` issue needs a **${priorityFieldName}**. Set the ${priorityFieldName} field in the sidebar.`,
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
  pullRequest: ContentObject,
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
            'and for users without access to this repository.',
        );
        return false;
      }
      core.info(`Auto-assigned: ${assigned.join(', ')}`);
      successMessages.push(
        `Auto-assigned: ${formatListWithBackticks(assigned)}`,
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

  const labels = getLabelNames(pullRequest);

  for (const prefixInput of requiredPrefixes) {
    const prefix = prefixInput.endsWith('/') ? prefixInput : `${prefixInput}/`;
    const hasLabelFromCategory = labels.some((label) =>
      label.startsWith(prefix),
    );

    if (!hasLabelFromCategory) {
      const errorMsg =
        getCustomErrorMessage(
          `missing_category_${prefixInput.replace('/', '')}`,
        ) || `Missing required label from category \`${prefix}\`.`;
      errorMessages.push(errorMsg);
      suggestedFixes.push(
        `Add a label with prefix \`${prefix}\` (e.g., ${prefix}example)`,
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
      `Rename your branch to match the pattern: \`${branchPattern}\``,
    );
  } else {
    successMessages.push(`Branch name matches required pattern`);
  }
}

run();

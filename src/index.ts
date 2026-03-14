import * as core from '@actions/core';
import * as github from '@actions/github';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
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

const PR_COMMENT_TITLE = 'Pull with Spice';

// Security: Maximum lengths to prevent DoS via extremely long inputs
const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 65536;
const MAX_LABEL_NAME_LENGTH = 100;
const MAX_LABELS_COUNT = 100;
const MAX_CHANGED_FILES = 3000;
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

async function run(): Promise<void> {
  try {
    // Get details from context - pull request only
    const pullRequest = github.context.payload.pull_request as
      | ContentObject
      | undefined;

    // If no PR in the context, this might be another event
    if (!pullRequest) {
      core.setFailed(
        'This action only works on pull requests. No pull request found in the context.',
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
    const autoLabelSizeEnabled = core.getInput('auto_label_size') === 'true';

    // Get changed files for auto-labeling (if enabled)
    let changedFiles: ChangedFile[] = [];
    if (
      octokit &&
      pullRequest.number &&
      (autoLabelEnabled || autoLabelSizeEnabled)
    ) {
      changedFiles = await getChangedFiles(octokit, pullRequest.number);
    }

    // Auto-labeling (runs before validation)
    if (octokit && pullRequest.number) {
      await performAutoLabeling(octokit, pullRequest, changedFiles);
    }

    // AI-powered auto-labeling (if enabled and Spice API key provided)
    const spiceApiKey = core.getInput('spice_api_key');
    const aiAutoLabelEnabled = core.getInput('ai_auto_label') === 'true';
    if (octokit && pullRequest.number && spiceApiKey && aiAutoLabelEnabled) {
      await performAIAutoLabeling(
        octokit,
        pullRequest,
        changedFiles,
        spiceApiKey,
      );
    }

    // Auto-assign (if enabled)
    if (octokit && pullRequest.number) {
      await performAutoAssign(octokit, pullRequest);
    }

    // Refresh labels after auto-labeling (only if we made changes)
    const needsRefresh =
      autoAppliedLabels.length > 0 || core.getInput('auto_assign') === 'true';
    if (octokit && pullRequest.number && needsRefresh) {
      const freshPR = await octokit.rest.pulls.get({
        ...github.context.repo,
        pull_number: pullRequest.number,
      });
      pullRequest.labels = freshPR.data.labels as Label[];
      pullRequest.assignees = freshPR.data.assignees as User[];
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

    // Post the report to the PR with all messages (errors and success)
    await postReportToPullRequest(errorMessages, successMessages);

    // If we have any errors, fail the action
    if (errorMessages.length > 0) {
      core.setFailed(
        'Pull request checks failed. See PR comments for details.',
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

    // Make sure we have a PR number
    if (!context.payload.pull_request?.number) {
      core.warning(
        'Could not find pull request number in context. Unable to post comments.',
      );
      return;
    }

    const prNumber = context.payload.pull_request.number;

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

// ============================================================================
// Auto-labeling Functions
// ============================================================================

async function getChangedFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  prNumber: number,
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

async function getRepositoryLabels(
  octokit: ReturnType<typeof github.getOctokit>,
): Promise<string[]> {
  try {
    const labels: string[] = [];
    let page = 1;
    let hasMore = true;

    // Paginate through all labels
    while (hasMore) {
      const response = await octokit.rest.issues.listLabelsForRepo({
        ...github.context.repo,
        per_page: 100,
        page: page,
      });

      if (response.data.length === 0) {
        hasMore = false;
      } else {
        labels.push(
          ...response.data.map((label: { name: string }) => label.name),
        );
        hasMore = response.data.length === 100;
        page++;
      }
    }

    core.info(`Found ${labels.length} labels in repository`);
    return labels;
  } catch (error) {
    core.warning(`Failed to get repository labels: ${error}`);
    return [];
  }
}

async function performAutoLabeling(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject,
  changedFiles: ChangedFile[],
): Promise<void> {
  const autoLabelEnabled = core.getInput('auto_label') === 'true';
  const autoLabelSizeEnabled = core.getInput('auto_label_size') === 'true';
  const autoLabelTypeEnabled = core.getInput('auto_label_type') === 'true';

  if (!autoLabelEnabled && !autoLabelSizeEnabled && !autoLabelTypeEnabled) {
    return;
  }

  const labelsToAdd: Set<string> = new Set();
  const currentLabels = (pullRequest.labels || []).map((l) => l.name);
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
    for (const file of changedFiles) {
      if (rule.paths.some((path) => file.filename.includes(path))) {
        const sanitizedLabel = sanitizeString(rule.label, MAX_LABEL_NAME_LENGTH);
        if (isKindLabel(sanitizedLabel)) {
          // Keep a single path-based kind label candidate.
          if (!pathBasedKindLabel) {
            pathBasedKindLabel = sanitizedLabel;
          }
        } else {
          labelsToAdd.add(sanitizedLabel);
        }
        break;
      }
    }
  }

  // Size-based labeling
  if (autoLabelSizeEnabled && changedFiles.length > 0) {
    const totalChanges = changedFiles.reduce(
      (sum, file) => sum + file.additions + file.deletions,
      0,
    );
    const sizeLabel = getSizeLabel(totalChanges);
    if (sizeLabel) {
      // Remove any existing size labels from our set
      const sizeLabels = ['size/xs', 'size/s', 'size/m', 'size/l', 'size/xl'];
      for (const sl of sizeLabels) {
        labelsToAdd.delete(sl);
      }
      labelsToAdd.add(sizeLabel);
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
    if (
      currentKindLabels.length === 0 ||
      currentKindLabels.includes(preferredKindLabel)
    ) {
      labelsToAdd.add(preferredKindLabel);
    } else {
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
    } catch (error) {
      core.warning(`Failed to apply labels: ${error}`);
    }
  }
}

function getSizeLabel(totalChanges: number): string {
  if (totalChanges < 11) return 'size/xs';
  if (totalChanges < 101) return 'size/s';
  if (totalChanges < 501) return 'size/m';
  if (totalChanges < 2000) return 'size/l';
  return 'size/xl';
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

// ============================================================================
// AI Auto-labeling Functions (Spice Cloud)
// ============================================================================

async function performAIAutoLabeling(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject,
  changedFiles: ChangedFile[],
  spiceApiKey: string,
): Promise<void> {
  try {
    core.info('Performing AI-powered auto-labeling refinement...');

    const currentLabels = (pullRequest.labels || []).map((l) => l.name);

    // Fetch available labels from the repository
    const repoLabels = await getRepositoryLabels(octokit);

    // Build the prompt for the LLM, including current labels for refinement
    const prompt = buildAILabelingPrompt(
      pullRequest,
      changedFiles,
      repoLabels,
      currentLabels,
    );

    // Call Spice Cloud LLM endpoint with structured output
    const analysis = await callSpiceLLM(spiceApiKey, prompt);

    if (!analysis) {
      core.info('AI analysis returned no response');
      aiAnalysisResults.push('AI analysis could not be completed.');
      return;
    }

    // Record the AI reasoning
    if (analysis.reasoning) {
      aiAnalysisResults.push(`**Reasoning:** ${analysis.reasoning}`);
    }

    let labelsToAdd = analysis.labelsToAdd.filter(
      (label: string) => !currentLabels.includes(label),
    );
    const labelsToRemove = analysis.labelsToRemove.filter((label: string) =>
      currentLabels.includes(label),
    );

    const aiKindLabelsToAdd = labelsToAdd.filter((label) => isKindLabel(label));
    if (aiKindLabelsToAdd.length > 1) {
      const preferredKindLabel = aiKindLabelsToAdd[0];
      labelsToAdd = labelsToAdd.filter(
        (label) => !isKindLabel(label) || label === preferredKindLabel,
      );
      core.info(
        `AI suggested multiple kind labels. Keeping only: ${preferredKindLabel}`,
      );
    }

    const currentKindLabels = currentLabels.filter((label) => isKindLabel(label));
    const removedKindLabels = labelsToRemove.filter((label) =>
      isKindLabel(label),
    );
    const remainingKindLabels = currentKindLabels.filter(
      (label) => !removedKindLabels.includes(label),
    );
    const kindLabelToAdd = labelsToAdd.find((label) => isKindLabel(label));

    if (
      kindLabelToAdd &&
      remainingKindLabels.length > 0 &&
      !remainingKindLabels.includes(kindLabelToAdd)
    ) {
      labelsToAdd = labelsToAdd.filter((label) => label !== kindLabelToAdd);
      core.info(
        `Skipping AI kind label "${kindLabelToAdd}" because pull request already has kind label(s): ${remainingKindLabels.join(', ')}`,
      );
    }

    // Remove labels that AI determined are incorrect
    if (labelsToRemove.length > 0 && pullRequest.number) {
      for (const label of labelsToRemove) {
        try {
          await octokit.rest.issues.removeLabel({
            ...github.context.repo,
            issue_number: pullRequest.number,
            name: label,
          });
          core.info(`AI removed label: ${label}`);
        } catch (error) {
          core.warning(`Failed to remove label ${label}: ${error}`);
        }
      }
      aiAnalysisResults.push(
        `**Labels removed by AI:** ${labelsToRemove.map((l: string) => `\`${l}\``).join(', ')}`,
      );
    }

    // Add labels that AI suggests
    if (labelsToAdd.length > 0 && pullRequest.number) {
      try {
        await octokit.rest.issues.addLabels({
          ...github.context.repo,
          issue_number: pullRequest.number,
          labels: labelsToAdd,
        });
        autoAppliedLabels.push(...labelsToAdd.map((l: string) => `${l} (AI)`));
        aiAnalysisResults.push(
          `**Labels added by AI:** ${labelsToAdd.map((l: string) => `\`${l}\``).join(', ')}`,
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
}

function buildAILabelingPrompt(
  pullRequest: ContentObject,
  changedFiles: ChangedFile[],
  repoLabels: string[],
  currentLabels: string[],
): string {
  const filesSummary = changedFiles
    .slice(0, 50) // Limit to first 50 files to keep prompt manageable
    .map((f) => `- ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join('\n');

  return `Review and refine the labels on this GitHub pull request.

## Pull Request Details

**Title:** ${pullRequest.title}

**Description:**
${pullRequest.body || 'No description provided'}

**Branch:** ${pullRequest.head?.ref || 'unknown'} -> ${pullRequest.base?.ref || 'unknown'}

**Changed Files (${changedFiles.length} total):**
${filesSummary}
${changedFiles.length > 50 ? `\n... and ${changedFiles.length - 50} more files` : ''}

## Currently Applied Labels
${currentLabels.length > 0 ? currentLabels.map((l) => `- ${l}`).join('\n') : 'No labels currently applied'}

## Available Labels in Repository
${repoLabels.map((l) => `- ${l}`).join('\n')}

## Instructions
Review the currently applied labels and suggest improvements:
1. Identify any labels that are incorrect or don't apply to this PR (add to labelsToRemove)
2. Identify any missing labels that should be added (add to labelsToAdd)
3. Consider the type of change, areas affected, and priority
4. Ensure there is at most one label that starts with kind/

Be conservative - only suggest changes you are confident about. If the current labels are appropriate, return empty arrays.`;
}

function getSpiceCloudBaseUrl(region: string): string {
  // Map region to Spice Cloud HTTP data endpoints for OpenAI-compatible APIs.
  const regionEndpoints: Record<string, string> = {
    'us-east-1': 'https://us-east-1-prod-aws-data.spiceai.io/v1',
    'us-west-2': 'https://us-west-2-prod-aws-data.spiceai.io/v1',
  };

  return regionEndpoints[region] ?? 'https://data.spiceai.io/v1';
}

function isOpenAIKey(apiKey: string): boolean {
  // OpenAI API keys start with 'sk-' (including service account keys 'sk-svcacct-')
  return apiKey.startsWith('sk-');
}

function sanitizeAILabelAnalysis(
  analysis: AILabelAnalysis,
): AILabelAnalysis {
  const sanitizedLabelsToAdd = analysis.labelsToAdd
    .map((label: string) => sanitizeString(label, MAX_LABEL_NAME_LENGTH))
    .filter((label: string) => label.length > 0);

  const sanitizedLabelsToRemove = analysis.labelsToRemove
    .map((label: string) => sanitizeString(label, MAX_LABEL_NAME_LENGTH))
    .filter((label: string) => label.length > 0);

  return {
    labelsToAdd: sanitizedLabelsToAdd,
    labelsToRemove: sanitizedLabelsToRemove,
    reasoning: sanitizeString(analysis.reasoning, MAX_BODY_LENGTH),
  };
}

function parseAILabelAnalysisFromText(text: string): AILabelAnalysis | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = AILabelAnalysisSchema.safeParse(parsed);
      if (validated.success) {
        return validated.data;
      }
    } catch {
      // Try the next parsing candidate.
    }
  }

  return null;
}

async function callSpiceLLM(
  apiKey: string,
  prompt: string,
): Promise<AILabelAnalysis | null> {
  try {
    const region = core.getInput('spice_cloud_region') || 'us-east-1';
    const modelInput = core.getInput('ai_model') || 'openai/gpt-4o-mini';

    // Determine if we're using OpenAI directly or Spice Cloud
    const useOpenAIDirect = isOpenAIKey(apiKey);

    if (useOpenAIDirect) {
      let model = modelInput;

      // If model doesn't include a slash (e.g., 'openai'), use a sensible default
      if (!model.includes('/')) {
        model = model || 'gpt-4o-mini';
      } else {
        // Extract model name from 'provider/model' format
        model = model.split('/').pop() || 'gpt-4o-mini';
      }
      core.info(`Using OpenAI directly with model: ${model}`);

      // Use native OpenAI provider for better structured output support
      const openai = createOpenAI({
        apiKey: apiKey,
      });
      const { output } = await generateText({
        model: openai(model),
        output: Output.object({
          schema: AILabelAnalysisSchema,
        }),
        system:
          'You are a helpful assistant that analyzes pull requests and suggests appropriate labels. Respond with JSON.',
        prompt: prompt,
      });

      if (!output) {
        core.warning('AI analysis returned no structured output');
        return null;
      }

      return sanitizeAILabelAnalysis(output);
    }

    const defaultBaseURL = 'https://data.spiceai.io/v1';
    const primaryBaseURL = getSpiceCloudBaseUrl(region);
    const baseURLs =
      primaryBaseURL === defaultBaseURL
        ? [primaryBaseURL]
        : [primaryBaseURL, defaultBaseURL];

    const modelCandidates = modelInput.includes('/')
      ? [modelInput, modelInput.split('/')[0] || 'openai']
      : [modelInput];
    if (!modelCandidates.includes('openai')) {
      modelCandidates.push('openai');
    }

    let lastError: unknown = null;

    for (const candidateModel of modelCandidates) {
      for (const baseURL of baseURLs) {
        core.info(
          `Using Spice Cloud region: ${region}, model: ${candidateModel}, base URL: ${baseURL}`,
        );

        try {
          const provider = createOpenAICompatible({
            name: 'spice-cloud',
            apiKey: apiKey,
            baseURL: baseURL,
            headers: {
              'X-API-Key': apiKey,
            },
          });

          // Some Spice-hosted models may not support response_format strictly,
          // so request JSON text and validate it ourselves.
          const { text } = await generateText({
            model: provider(candidateModel),
            system:
              'You analyze pull requests and suggest labels. Return only valid JSON with this exact shape: {"labelsToAdd": string[], "labelsToRemove": string[], "reasoning": string}.',
            prompt: prompt,
          });

          const parsed = parseAILabelAnalysisFromText(text);
          if (!parsed) {
            core.warning(
              `AI analysis returned non-JSON output from Spice model "${candidateModel}"`,
            );
            core.info(`Raw AI response preview: ${text.slice(0, 500)}`);
            continue;
          }

          return sanitizeAILabelAnalysis(parsed);
        } catch (error) {
          lastError = error;
          const err = error as Error & { statusCode?: number };
          const statusSuffix = err.statusCode
            ? ` (status ${err.statusCode})`
            : '';
          core.warning(
            `Spice AI call failed for model "${candidateModel}" at ${baseURL}${statusSuffix}: ${err.message || err.name}`,
          );
        }
      }
    }

    if (lastError instanceof Error) {
      core.warning(`Failed to call AI LLM: ${lastError.message}`);
      core.info(`Full error details: ${lastError.stack}`);
      core.info(
        `Error payload: ${JSON.stringify(lastError, Object.getOwnPropertyNames(lastError))}`,
      );
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to call AI LLM: ${error.message}`);
      core.info(`Full error details: ${error.stack}`);
      core.info(
        `Error payload: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`,
      );
    }
    return null;
  }
}

// ============================================================================
// Auto-assign Functions
// ============================================================================

async function performAutoAssign(
  octokit: ReturnType<typeof github.getOctokit>,
  pullRequest: ContentObject,
): Promise<void> {
  const autoAssignEnabled = core.getInput('auto_assign') === 'true';
  if (!autoAssignEnabled || !pullRequest.number) {
    return;
  }

  // Check if already has assignees
  if (pullRequest.assignees && pullRequest.assignees.length > 0) {
    return;
  }

  const autoAssignees = getInputArray('auto_assign_users');
  const assignAuthor = core.getInput('auto_assign_author') === 'true';

  const assigneesToAdd: string[] = [];

  // Assign the PR author
  if (assignAuthor && pullRequest.user?.login) {
    assigneesToAdd.push(pullRequest.user.login);
  }

  // Add configured auto-assignees
  assigneesToAdd.push(...autoAssignees);

  if (assigneesToAdd.length > 0) {
    try {
      await octokit.rest.issues.addAssignees({
        ...github.context.repo,
        issue_number: pullRequest.number,
        assignees: [...new Set(assigneesToAdd)],
      });
      core.info(`Auto-assigned: ${assigneesToAdd.join(', ')}`);
      successMessages.push(
        `Auto-assigned: ${formatListWithBackticks(assigneesToAdd)}`,
      );
    } catch (error) {
      core.warning(`Failed to auto-assign: ${error}`);
    }
  }
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

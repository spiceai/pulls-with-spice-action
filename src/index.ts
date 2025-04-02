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

interface ContentObject {
  title: string;
  body?: string;
  labels?: Label[];
  assignees?: User[];
  draft?: boolean;
}

// Collect errors instead of failing immediately
const errorMessages: string[] = [];

async function run(): Promise<void> {
  try {
    // Get details from context - pull request only
    const pullRequest = github.context.payload.pull_request as
      | ContentObject
      | undefined;

    // If no PR in the context, this might be another event
    if (!pullRequest) {
      core.setFailed(
        'This action only works on pull requests. No pull request found in the context.'
      );
      return;
    }

    // Run all the quality checks
    checkTitle(pullRequest);
    checkDescription(pullRequest);
    checkLabels(pullRequest);
    checkAssignees(pullRequest);
    checkIssueType(pullRequest);
    checkDraft(pullRequest);

    // If we have collected any errors, post them to the PR and fail
    if (errorMessages.length > 0) {
      await postErrorsToPullRequest(errorMessages);
      core.setFailed(
        'Pull request quality checks failed. See PR comments for details.'
      );
      return;
    }

    core.info('All pull request quality checks passed!');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

async function postErrorsToPullRequest(errors: string[]): Promise<void> {
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

    // Make sure we have a PR number
    if (!context.payload.pull_request?.number) {
      core.warning(
        'Could not find pull request number in context. Unable to post comments.'
      );
      return;
    }

    const prNumber = context.payload.pull_request.number;

    // Format the comment message
    const errorMessage =
      `## 🔍 Pull Request Quality Check Failed\n\n` +
      `The following issues were found with your pull request:\n\n` +
      errors.map((err) => `- ${err}`).join('\n') +
      `\n\nPlease address these issues and update your pull request.`;

    // Post the comment to the PR
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: prNumber,
      body: errorMessage,
    });

    core.info('Posted quality check errors to pull request.');
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
  if (minLength && pullRequest.title.length < minLength) {
    const errorMsg =
      getCustomErrorMessage('title_too_short') ||
      `Pull request title is too short. Minimum length is ${minLength} characters.`;
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function checkDescription(pullRequest: ContentObject): void {
  const minLength = parseInt(
    core.getInput('require_description_min_length'),
    10
  );
  if (minLength && (!pullRequest.body || pullRequest.body.length < minLength)) {
    const errorMsg =
      getCustomErrorMessage('description_too_short') ||
      `Pull request description is too short. Minimum length is ${minLength} characters.`;
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function checkLabels(pullRequest: ContentObject): void {
  const labels = pullRequest.labels || [];
  const labelNames = labels.map((l) => l.name);

  // Check if any of the required labels are present
  enforceAnyLabels(labelNames);

  // Check if all of the required labels are present
  enforceAllLabels(labelNames);

  // Check if any banned labels are present
  enforceBannedLabels(labelNames);
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
      `Pull request must include one of these issue types: ${requiredIssueTypes.join(', ')}. Format should be "type: description" or "type(scope): description".`;
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function enforceAnyLabels(labels: string[]): void {
  const requiredLabelsAny = getInputArray('required_labels_any');
  if (
    requiredLabelsAny.length > 0 &&
    !requiredLabelsAny.some((requiredLabel) => labels.includes(requiredLabel))
  ) {
    const errorMsg =
      getCustomErrorMessage('missing_any_labels') ||
      `Please select at least one of the required labels for this pull request: ${requiredLabelsAny.join(
        ', '
      )}`;
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function enforceAllLabels(labels: string[]): void {
  const requiredLabelsAll = getInputArray('required_labels_all');
  if (
    requiredLabelsAll.length > 0 &&
    !requiredLabelsAll.every((requiredLabel) => labels.includes(requiredLabel))
  ) {
    const missingLabels = requiredLabelsAll.filter(
      (label) => !labels.includes(label)
    );
    const errorMsg =
      getCustomErrorMessage('missing_all_labels') ||
      `The following required labels are missing from this pull request: ${missingLabels.join(', ')}`;
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function enforceBannedLabels(labels: string[]): void {
  const bannedLabels = getInputArray('banned_labels');
  const bannedLabel = labels.find((label) => bannedLabels.includes(label));
  if (bannedLabels.length > 0 && bannedLabel) {
    const errorMsg =
      getCustomErrorMessage('banned_label') ||
      `The label "${bannedLabel}" is not allowed for this pull request.`;
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function checkAssignees(pullRequest: ContentObject): void {
  const requireAssignee = core.getInput('require_assignee') === 'true';
  if (
    requireAssignee &&
    (!pullRequest.assignees || pullRequest.assignees.length === 0)
  ) {
    const errorMsg =
      getCustomErrorMessage('no_assignee') ||
      'At least one assignee is required for this pull request.';
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
  }
}

function checkDraft(pullRequest: ContentObject): void {
  const enforceDraft = core.getInput('enforce_draft') === 'true';
  if (enforceDraft && pullRequest.draft) {
    const errorMsg =
      getCustomErrorMessage('is_draft') ||
      'Draft pull requests are not allowed. Please mark as ready for review.';
    // Instead of failing immediately, collect the error
    errorMessages.push(errorMsg);
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

run();

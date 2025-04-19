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

const PR_COMMENT_TITLE = 'Pull with Spice';

// Collect errors and success messages
const errorMessages: string[] = [];
const successMessages: string[] = [];

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

    // Post the report to the PR with all messages (errors and success)
    await postReportToPullRequest(errorMessages, successMessages);

    // If we have any errors, fail the action
    if (errorMessages.length > 0) {
      core.setFailed(
        'Pull request checks failed. See PR comments for details.'
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

    // Make sure we have a PR number
    if (!context.payload.pull_request?.number) {
      core.warning(
        'Could not find pull request number in context. Unable to post comments.'
      );
      return;
    }

    const prNumber = context.payload.pull_request.number;

    // Format the comment message
    let statusHeader =
      errors.length > 0
        ? `## 🔍 ${PR_COMMENT_TITLE} Failed\n\n`
        : `## ✅ ${PR_COMMENT_TITLE} Passed\n\n`;

    let statusBody = '';

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

run();

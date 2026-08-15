/**
 * The checks have to describe the subject as it is when they run, not as the event payload
 * froze it. Re-running a workflow replays the original payload, so a gate reading mutable
 * metadata reproduces its old verdict instead of observing the change that discharged it.
 *
 * Every case here loads the action the way the runner does — the pass starts on import — with
 * the payload and the API deliberately disagreeing about the subject.
 */

import { jest } from '@jest/globals';

type Inputs = Record<string, string>;

interface Scenario {
  inputs?: Inputs;
  /** The event payload, as frozen when the run was created. */
  payload: Record<string, unknown>;
  /** What the API reports for the subject now. */
  current?: Record<string, unknown>;
  /** Set to make both read endpoints reject, standing in for an API outage. */
  readError?: Error;
  /** Omit the token, leaving the action with no way to read the subject. */
  withoutToken?: boolean;
}

interface CoreStub {
  getInput: jest.Mock<(name: string) => string>;
  info: jest.Mock<(message: string) => void>;
  warning: jest.Mock<(message: string) => void>;
  error: jest.Mock<(message: string) => void>;
  setFailed: jest.Mock<(message: string) => void>;
  setSecret: jest.Mock<(secret: string) => void>;
}

function coreStub(inputs: Inputs): CoreStub {
  return {
    getInput: jest.fn((name: string) => inputs[name] ?? ''),
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    setFailed: jest.fn(),
    setSecret: jest.fn(),
  };
}

/**
 * Loads a fresh copy of the action against the scenario's mocks and waits for its pass.
 *
 * The module registry is reset for each load: the action collects its verdict in module-level
 * state, so a shared instance would carry one case's errors into the next.
 */
async function runAction(scenario: Scenario): Promise<{
  core: CoreStub;
  issuesGet: jest.Mock;
  action: typeof import('./index');
}> {
  jest.resetModules();

  const core = coreStub({
    ...(scenario.withoutToken ? {} : { github_token: 'a-token' }),
    ...scenario.inputs,
  });

  const { readError } = scenario;
  const issuesGet = readError
    ? jest.fn(async () => {
        throw readError;
      })
    : jest.fn(async () => ({ data: scenario.current }));

  const octokit = {
    rest: {
      issues: {
        get: issuesGet,
        listComments: jest.fn(async () => ({ data: [] })),
        createComment: jest.fn(async () => ({ data: {} })),
        updateComment: jest.fn(async () => ({ data: {} })),
      },
    },
  };

  jest.unstable_mockModule('@actions/core', () => core);
  jest.unstable_mockModule('@actions/github', () => ({
    context: {
      payload: scenario.payload,
      repo: { owner: 'spiceai', repo: 'spiceai' },
      actor: 'contributor',
    },
    getOctokit: jest.fn(() => octokit),
  }));

  const action = await import('./index');
  await action.completed;

  return { core, issuesGet, action };
}

/** A pull request as the payload carries it, before any of the metadata below was applied. */
const PULL_REQUEST = {
  number: 12739,
  title: 'fix: a perfectly good pull request',
  body: 'A description long enough to satisfy the description check.',
  labels: [],
  assignees: [],
  draft: false,
  user: { login: 'contributor' },
  head: { ref: 'fix/12726-byoc-lint-debt' },
  base: { ref: 'trunk' },
};

describe('evaluating the subject as it is now', () => {
  it('passes a pull request whose assignee landed after the payload was cut', async () => {
    // The `opened` payload a re-run replays: `gh pr create` had not yet assigned anyone.
    const { core } = await runAction({
      inputs: { require_assignee: 'true' },
      payload: { pull_request: { ...PULL_REQUEST, assignees: [] } },
      current: { ...PULL_REQUEST, assignees: [{ login: 'claudespice' }] },
    });

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('fails a pull request whose assignee has since been removed', async () => {
    // The mirror of the case above. Without it, an implementation that only ever added to the
    // payload would pass both — read state has to replace what the payload said, not merge with it.
    const { core } = await runAction({
      inputs: { require_assignee: 'true' },
      payload: {
        pull_request: {
          ...PULL_REQUEST,
          assignees: [{ login: 'claudespice' }],
        },
      },
      current: { ...PULL_REQUEST, assignees: [] },
    });

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('At least one assignee is required'),
    );
  });

  it('reads the labels the pull request carries now, in either shape', async () => {
    // The issues endpoint can report a label as a bare string. Left unhandled it has no `name`,
    // so a label plainly applied reads as missing.
    const { core } = await runAction({
      inputs: { required_label_prefixes: 'kind/,area/' },
      payload: { pull_request: { ...PULL_REQUEST, labels: [] } },
      current: {
        ...PULL_REQUEST,
        labels: ['kind/bug', { name: 'area/cayenne' }],
      },
    });

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('fails when a required label has since been removed', async () => {
    const { core } = await runAction({
      inputs: { required_label_prefixes: 'kind/' },
      payload: {
        pull_request: { ...PULL_REQUEST, labels: [{ name: 'kind/bug' }] },
      },
      current: { ...PULL_REQUEST, labels: [] },
    });

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('kind/'),
    );
  });

  it('reads the draft state the pull request is in now', async () => {
    const { core } = await runAction({
      inputs: { enforce_draft: 'true' },
      payload: { pull_request: { ...PULL_REQUEST, draft: true } },
      current: { ...PULL_REQUEST, draft: false },
    });

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('fails a pull request returned to draft after the payload was cut', async () => {
    const { core } = await runAction({
      inputs: { enforce_draft: 'true' },
      payload: { pull_request: { ...PULL_REQUEST, draft: false } },
      current: { ...PULL_REQUEST, draft: true },
    });

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Draft pull requests are not allowed'),
    );
  });

  it('reads whichever subject the event delivered', async () => {
    // One endpoint serves both — a pull request is an issue — so the read does not have to
    // know which kind of subject it was handed.
    const asPull = await runAction({
      payload: { pull_request: PULL_REQUEST },
      current: PULL_REQUEST,
    });
    expect(asPull.issuesGet).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 12739 }),
    );

    const asIssue = await runAction({
      payload: { issue: { ...PULL_REQUEST, number: 12805 } },
      current: { ...PULL_REQUEST, number: 12805 },
    });
    expect(asIssue.issuesGet).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 12805 }),
    );
  });
});

describe('when the subject cannot be read', () => {
  it('falls back to the payload rather than failing the check', async () => {
    // Failing here would mint exactly the false red this read exists to remove.
    const { core } = await runAction({
      inputs: { require_assignee: 'true' },
      payload: {
        pull_request: {
          ...PULL_REQUEST,
          assignees: [{ login: 'claudespice' }],
        },
      },
      readError: new Error('API rate limit exceeded'),
    });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Falling back to the event payload'),
    );
  });

  it('says so when there is no token to read it with', async () => {
    const { core } = await runAction({
      inputs: { require_assignee: 'true' },
      payload: {
        pull_request: {
          ...PULL_REQUEST,
          assignees: [{ login: 'claudespice' }],
        },
      },
      withoutToken: true,
    });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('No GitHub token provided'),
    );
  });
});

describe('applying what was read', () => {
  it('bounds API-read state, not only the payload', async () => {
    const { action } = await runAction({
      payload: { pull_request: PULL_REQUEST },
      current: PULL_REQUEST,
    });

    const subject: Parameters<typeof action.applySubjectState>[0] = {
      title: 'the payload title',
    };
    action.applySubjectState(subject, {
      title: 'a'.repeat(600),
      body: 'b'.repeat(70_000),
      labels: Array.from({ length: 150 }, (_, i) => ({ name: `label-${i}` })),
    });

    expect(subject.title).toHaveLength(500);
    expect(subject.body).toHaveLength(65_536);
    expect(subject.labels).toHaveLength(100);
  });

  it('drops a label the response reports without a name', async () => {
    const { action } = await runAction({
      payload: { pull_request: PULL_REQUEST },
      current: PULL_REQUEST,
    });

    const subject: Parameters<typeof action.applySubjectState>[0] = {
      title: 'a pull request',
    };
    action.applySubjectState(subject, { labels: [{}, { name: 'kind/bug' }] });

    expect(subject.labels).toEqual([{ name: 'kind/bug' }]);
  });

  it('clears a milestone that is no longer set', async () => {
    const { action } = await runAction({
      payload: { pull_request: PULL_REQUEST },
      current: PULL_REQUEST,
    });

    const subject: Parameters<typeof action.applySubjectState>[0] = {
      title: 'a pull request',
      milestone: { title: 'v1.10.0', number: 4 },
    };
    action.applySubjectState(subject, { milestone: null });

    expect(subject.milestone).toBeUndefined();
  });

  it('leaves a field the response does not carry alone', async () => {
    // An omitted field is not the same as one reported unset: a response that says nothing
    // about the draft state must not be read as "not a draft".
    const { action } = await runAction({
      payload: { pull_request: PULL_REQUEST },
      current: PULL_REQUEST,
    });

    const subject: Parameters<typeof action.applySubjectState>[0] = {
      title: 'the payload title',
      draft: true,
    };
    action.applySubjectState(subject, { labels: [] });

    expect(subject.draft).toBe(true);
    expect(subject.title).toBe('the payload title');
  });
});

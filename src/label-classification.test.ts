/// <reference types="jest" />

import type { ChoiceQuestion, NoulQuestion } from '@typesafe-ai/sdk';
import {
  KIND_QUESTION_ID,
  appliesQuestionId,
  buildClassificationRequest,
  interpretClassification,
  kindAddsToRollback,
  noneOptionKey,
  planLabelEdits,
  resolveTypesafeModel,
  type ClassifiedLabel,
  type ClassificationSubject,
  type LabelPolicy,
} from './label-classification';

const emptyPolicy: LabelPolicy = {
  requiredAny: [],
  requiredAll: [],
  requiredPrefixes: [],
  banned: [],
};

function subject(
  overrides: Partial<ClassificationSubject> = {},
): ClassificationSubject {
  return {
    title: 'feat: add label classification',
    description: 'Classify pull request labels.',
    head: 'feature/labels',
    base: 'main',
    changedFiles: [{ path: 'src/index.ts', additions: 10, deletions: 2 }],
    omittedFileCount: 0,
    ...overrides,
  };
}

function labels(...names: string[]): ClassifiedLabel[] {
  return names.map((name) => ({ name, description: '' }));
}

function choiceQuestion(
  request: NonNullable<ReturnType<typeof buildClassificationRequest>>,
): ChoiceQuestion {
  const question = request.questions[KIND_QUESTION_ID];
  if (!question || question.type !== 'choice') {
    throw new Error('expected a kind choice question');
  }
  return question;
}

function noulQuestion(
  request: NonNullable<ReturnType<typeof buildClassificationRequest>>,
  label: string,
): NoulQuestion {
  const question = request.questions[appliesQuestionId(label)];
  if (!question || question.type !== 'noul') {
    throw new Error(`expected a noul for ${label}`);
  }
  return question;
}

describe('resolveTypesafeModel', () => {
  it('keeps a Jev model id and ignores the Spice default', () => {
    expect(resolveTypesafeModel('openai', undefined)).toBe('jev-latest');
    expect(resolveTypesafeModel('  jev-1.13.0  ', 'jev-latest')).toBe(
      'jev-1.13.0',
    );
    expect(resolveTypesafeModel('openai', 'jev-1.12.0')).toBe('jev-1.12.0');
    expect(resolveTypesafeModel('gpt-5.4', '  ')).toBe('jev-latest');
  });
});

describe('buildClassificationRequest', () => {
  const repository = [
    { name: 'kind/bug', description: 'A defect' },
    { name: 'kind/feature', description: '   ' },
    { name: 'area/docs', description: 'Documentation' },
    { name: 'area/runtime', description: '' },
    { name: 'good first issue', description: 'Easy' },
  ];

  it('asks one kind choice and a yes/no question for every other label', () => {
    const request = buildClassificationRequest(
      subject(),
      repository,
      ['area/docs'],
      ['area/'],
    );

    expect(request).not.toBeNull();
    if (!request) return;

    expect(request.kindLabels).toEqual(['kind/bug', 'kind/feature']);
    expect(request.noulLabels).toEqual([
      'area/docs',
      'area/runtime',
      'good first issue',
    ]);
    expect(request.questions[appliesQuestionId('kind/bug')]).toBeUndefined();

    const kind = choiceQuestion(request);
    expect(kind.criteria['kind/bug']).toBe('A defect');
    expect(kind.criteria['kind/feature']).toBeNull();
    expect(kind.criteria[request.noneKey]).toBe(
      'None of these kind/ labels apply',
    );
    expect(JSON.stringify(kind.instructions)).toContain('lock file');
    expect(JSON.stringify(kind.instructions)).toContain('feat:');

    const docs = noulQuestion(request, 'area/docs');
    expect(JSON.stringify(docs.instructions)).toContain('area/docs');
    expect(docs.criteria?.true).toEqual(expect.any(String));

    expect(request.state).not.toHaveProperty('current_labels');
    expect(JSON.parse(JSON.stringify(request.state))).toEqual(request.state);
  });

  it('prefers current labels when the question set is capped', () => {
    const request = buildClassificationRequest(
      subject(),
      [
        ...labels('kind/a', 'kind/b', 'kind/c'),
        ...labels('area/a', 'area/b', 'plain'),
      ],
      ['kind/c', 'plain'],
      ['area/'],
      { maxKindOptions: 2, maxNoulQuestions: 2, descriptionLength: 300 },
    );

    expect(request?.kindLabels).toEqual(['kind/c', 'kind/a']);
    expect(request?.omittedKind).toBe(1);
    expect(request?.noulLabels).toEqual(['plain', 'area/a']);
    expect(request?.omittedNoul).toBe(1);
  });

  it('truncates long descriptions and skips blank names', () => {
    const request = buildClassificationRequest(
      subject(),
      [
        { name: 'kind/bug', description: 'd'.repeat(400) },
        { name: '   ', description: 'ignored' },
        { name: 'area/docs', description: 'docs' },
      ],
      [],
      [],
      { maxKindOptions: 10, maxNoulQuestions: 10, descriptionLength: 20 },
    );

    expect(request?.kindLabels).toEqual(['kind/bug']);
    const kind = request && choiceQuestion(request);
    expect(kind && kind.criteria['kind/bug']).toBe('d'.repeat(20));
    expect(request?.noulLabels).toEqual(['area/docs']);
  });

  it('picks a none option that is not a real label', () => {
    expect(noneOptionKey(['none', '__none__', '__no_kind_label__'])).toBe(
      '__no_kind_label_0__',
    );

    const request = buildClassificationRequest(
      subject(),
      labels('kind/bug', 'none', '__none__', '__no_kind_label__'),
      [],
      [],
    );
    // `none` is not a kind/ label, so it is a yes/no question and the choice may use that key.
    expect(request?.noneKey).toBe('none');
    expect(request?.noulLabels).toContain('none');
    expect(request && choiceQuestion(request).criteria.none).toBe(
      'None of these kind/ labels apply',
    );
  });

  it('returns null when there is nothing to ask', () => {
    expect(
      buildClassificationRequest(
        subject(),
        [{ name: ' ', description: '' }],
        [],
        [],
      ),
    ).toBeNull();
  });
});

describe('interpretClassification', () => {
  const kindLabels = ['kind/bug', 'kind/feature'];

  it('replaces the current kind label when the choice is confident', () => {
    const result = interpretClassification({
      model: 'jev-1.13.0',
      answers: {
        [KIND_QUESTION_ID]: {
          type: 'choice',
          choice: 'kind/bug',
          confidence: 0.91,
        },
      },
      kindLabels,
      noneKey: 'none',
      noulLabels: [],
      currentLabels: ['kind/feature'],
    });

    expect(result.labelsToAdd).toEqual(['kind/bug']);
    expect(result.labelsToRemove).toEqual(['kind/feature']);
    expect(result.reasoning).toContain('jev-1.13.0');
    expect(result.reasoning).toContain('replacing');
  });

  it('leaves kind unchanged below the confidence threshold', () => {
    const result = interpretClassification({
      model: 'jev-latest',
      answers: {
        [KIND_QUESTION_ID]: {
          type: 'choice',
          choice: 'kind/bug',
          confidence: 0.49,
        },
      },
      kindLabels,
      noneKey: 'none',
      noulLabels: [],
      currentLabels: ['kind/feature'],
    });

    expect(result.labelsToAdd).toEqual([]);
    expect(result.labelsToRemove).toEqual([]);
    expect(result.reasoning).toContain('unchanged');
  });

  it('removes offered kind labels when none applies', () => {
    const result = interpretClassification({
      model: 'jev-latest',
      answers: {
        [KIND_QUESTION_ID]: { type: 'choice', choice: 'none', confidence: 0.8 },
      },
      kindLabels,
      noneKey: 'none',
      noulLabels: [],
      currentLabels: ['kind/bug', 'kind/hidden', 'area/docs'],
    });

    expect(result.labelsToRemove).toEqual(['kind/bug']);
    expect(result.labelsToAdd).toEqual([]);
  });

  it('drops an extra kind label when the chosen one is already applied', () => {
    const result = interpretClassification({
      model: 'jev-latest',
      answers: {
        [KIND_QUESTION_ID]: {
          type: 'choice',
          choice: 'kind/bug',
          confidence: 0.95,
        },
      },
      kindLabels,
      noneKey: 'none',
      noulLabels: [],
      currentLabels: ['kind/bug', 'kind/feature'],
    });

    expect(result.labelsToAdd).toEqual([]);
    expect(result.labelsToRemove).toEqual(['kind/feature']);
  });

  it('ignores a choice that was not offered', () => {
    const result = interpretClassification({
      model: 'jev-latest',
      answers: {
        [KIND_QUESTION_ID]: {
          type: 'choice',
          choice: 'kind/invented',
          confidence: 0.99,
        },
      },
      kindLabels,
      noneKey: 'none',
      noulLabels: [],
      currentLabels: ['kind/bug'],
    });

    expect(result.labelsToAdd).toEqual([]);
    expect(result.labelsToRemove).toEqual([]);
    expect(result.reasoning).toContain('kind/invented');
  });

  it('adds, removes, and abstains on noul probabilities', () => {
    const result = interpretClassification({
      model: 'jev-latest',
      answers: {
        [appliesQuestionId('area/runtime')]: { type: 'noul', noul: 0.8 },
        [appliesQuestionId('area/docs')]: { type: 'noul', noul: 0.2 },
        [appliesQuestionId('area/tests')]: { type: 'noul', noul: 0.5 },
        [appliesQuestionId('area/cli')]: { type: 'noul', noul: 0.79 },
      },
      kindLabels: [],
      noneKey: 'none',
      noulLabels: ['area/runtime', 'area/docs', 'area/tests', 'area/cli'],
      currentLabels: ['area/docs', 'area/tests'],
    });

    expect(result.labelsToAdd).toEqual(['area/runtime']);
    expect(result.labelsToRemove).toEqual(['area/docs']);
    expect(result.reasoning).toContain('2 labels unchanged');
  });

  it('leaves a label alone when its answer is missing', () => {
    const result = interpretClassification({
      model: 'jev-latest',
      answers: {},
      kindLabels: [],
      noneKey: 'none',
      noulLabels: ['area/docs'],
      currentLabels: ['area/docs'],
    });

    expect(result.labelsToRemove).toEqual([]);
    expect(result.reasoning).toContain('1 label unchanged');
  });
});

describe('planLabelEdits', () => {
  it('replaces a required kind label when another kind label is added', () => {
    const plan = planLabelEdits(['kind/bug'], ['kind/feature'], ['kind/bug'], {
      ...emptyPolicy,
      requiredPrefixes: ['kind/'],
    });

    expect(plan.labelsToAdd).toEqual(['kind/feature']);
    expect(plan.labelsToRemove).toEqual(['kind/bug']);
    expect(plan.refusedRemovals).toEqual([]);
  });

  it('keeps the last label that satisfies a required prefix', () => {
    const plan = planLabelEdits(['kind/bug'], [], ['kind/bug'], {
      ...emptyPolicy,
      requiredPrefixes: ['kind/'],
    });

    expect(plan.labelsToRemove).toEqual([]);
    expect(plan.refusedRemovals).toEqual(['kind/bug']);
  });

  it('keeps a label named by required_labels_all and does not add a second kind', () => {
    const plan = planLabelEdits(['kind/bug'], ['kind/feature'], ['kind/bug'], {
      ...emptyPolicy,
      requiredAll: ['kind/bug'],
    });

    expect(plan.labelsToAdd).toEqual([]);
    expect(plan.labelsToRemove).toEqual([]);
    expect(plan.refusedRemovals).toEqual(['kind/bug']);
    expect(plan.rejectedKindLabels).toEqual(['kind/feature']);
  });

  it('keeps one label when every label in a required category would be removed', () => {
    const plan = planLabelEdits(
      ['area/docs', 'area/runtime'],
      [],
      ['area/docs', 'area/runtime'],
      { ...emptyPolicy, requiredPrefixes: ['area/'] },
    );

    expect(plan.labelsToRemove).toEqual(['area/runtime']);
    expect(plan.refusedRemovals).toEqual(['area/docs']);
  });

  it('allows a removal that a non-kind addition still satisfies', () => {
    const plan = planLabelEdits(
      ['priority/p1'],
      ['priority/p0'],
      ['priority/p1'],
      { ...emptyPolicy, requiredAny: ['priority/p0', 'priority/p1'] },
    );

    expect(plan.labelsToAdd).toEqual(['priority/p0']);
    expect(plan.labelsToRemove).toEqual(['priority/p1']);
  });

  it('keeps a required kind label when its replacement is not on the pull request yet', () => {
    const policy = { ...emptyPolicy, requiredPrefixes: ['kind/'] };
    const proposed = planLabelEdits(
      ['kind/bug'],
      ['kind/feature'],
      ['kind/bug'],
      policy,
    );
    const withoutTheAdd = planLabelEdits(
      ['kind/bug'],
      [],
      proposed.labelsToRemove,
      policy,
    );
    const withTheAdd = planLabelEdits(
      ['kind/bug', ...proposed.labelsToAdd],
      [],
      proposed.labelsToRemove,
      policy,
    );

    expect(proposed.labelsToAdd).toEqual(['kind/feature']);
    expect(withoutTheAdd.labelsToRemove).toEqual([]);
    expect(withTheAdd.labelsToRemove).toEqual(['kind/bug']);
  });

  it('drops a second kind label while one survives, and never adds a banned label', () => {
    const plan = planLabelEdits(
      ['kind/bug'],
      ['kind/feature', 'kind/docs', 'area/banned'],
      [],
      { ...emptyPolicy, banned: ['area/banned'] },
    );

    expect(plan.labelsToAdd).toEqual([]);
    expect(plan.rejectedKindLabels).toEqual(['kind/feature', 'kind/docs']);
  });
});

describe('kindAddsToRollback', () => {
  it('rolls back newly added kind labels when an old kind removal failed', () => {
    expect(
      kindAddsToRollback(['kind/feature', 'area/docs'], ['kind/bug']),
    ).toEqual(['kind/feature']);
  });

  it('does not roll back when only a non-kind removal failed', () => {
    expect(
      kindAddsToRollback(['kind/feature', 'area/docs'], ['area/runtime']),
    ).toEqual([]);
  });

  it('does not roll back when every kind removal succeeded', () => {
    expect(kindAddsToRollback(['kind/feature'], [])).toEqual([]);
  });

  it('returns every newly added kind label when a kind removal failed', () => {
    expect(
      kindAddsToRollback(['kind/feature', 'kind/docs'], ['kind/bug', 'area/x']),
    ).toEqual(['kind/feature', 'kind/docs']);
  });
});

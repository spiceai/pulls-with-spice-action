import { choice, noul } from '@typesafe-ai/sdk';
import type { EntryType, Questions } from '@typesafe-ai/sdk';

/**
 * Label decisions for TypeSafe Jev.
 *
 * Jev answers typed questions; it does not invent label names. `kind/` is one Choice,
 * because this action already treats that prefix as mutually exclusive, plus an explicit
 * "none" option so a pull request is not forced into a kind. Every other label is its own
 * yes/no question, so a prefix such as `area/` can still carry more than one label.
 *
 * The model only classifies. Thresholds and the workflow's label policy live here, and a
 * low-confidence answer leaves the pull request alone.
 */

export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';

/** Act on a Choice at or above this confidence. Below it, Jev is not sure enough to relabel. */
export const CHOICE_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Noul is a probability, not a separate confidence. A clear yes adds the label and a clear
 * no removes it. The band in between is left untouched.
 */
export const NOUL_APPLY_THRESHOLD = 0.8;
export const NOUL_REMOVE_THRESHOLD = 0.2;

/** Choice allows 255 options. One of them is "none". */
export const MAX_KIND_OPTIONS = 254;

/** Independent labels asked in the same request. Enough for a real label set, still one call. */
export const MAX_NOUL_QUESTIONS = 200;

export const LABEL_DESCRIPTION_MAX = 300;

export const KIND_QUESTION_ID = 'category:kind';

export function appliesQuestionId(label: string): string {
  return `applies:${label}`;
}

export interface ClassifiedLabel {
  name: string;
  description: string;
}

export interface ChangedFileSummary {
  path: string;
  additions: number;
  deletions: number;
}

/** The pull request as Jev should see it: what changed, not which labels are already on it. */
export interface ClassificationSubject {
  title: string;
  description: string | null;
  head: string | null;
  base: string | null;
  changedFiles: ChangedFileSummary[];
  omittedFileCount: number;
}

export interface ClassificationLimits {
  maxKindOptions: number;
  maxNoulQuestions: number;
  descriptionLength: number;
}

export const DEFAULT_CLASSIFICATION_LIMITS: ClassificationLimits = {
  maxKindOptions: MAX_KIND_OPTIONS,
  maxNoulQuestions: MAX_NOUL_QUESTIONS,
  descriptionLength: LABEL_DESCRIPTION_MAX,
};

export interface ClassificationRequest {
  state: EntryType;
  questions: Questions;
  kindLabels: string[];
  noneKey: string;
  noulLabels: string[];
  omittedKind: number;
  omittedNoul: number;
}

export interface LabelClassification {
  labelsToAdd: string[];
  labelsToRemove: string[];
  reasoning: string;
}

export interface LabelPolicy {
  requiredAny: readonly string[];
  requiredAll: readonly string[];
  /** Prefixes including the trailing slash, as `required_label_prefixes` is matched. */
  requiredPrefixes: readonly string[];
  /** Never added. Removing one is still allowed: the checks forbid it from staying on. */
  banned: readonly string[];
}

export interface PlannedLabelEdits {
  labelsToAdd: string[];
  labelsToRemove: string[];
  refusedRemovals: string[];
  rejectedKindLabels: string[];
}

export function isKindLabel(label: string): boolean {
  return label.startsWith('kind/');
}

export function normalizeLabelPrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/**
 * A `jev*` model id is a TypeSafe model. Anything else belongs to Spice Cloud or OpenAI,
 * so Jev falls through to its own default rather than sending that name to TypeSafe.
 */
export function resolveTypesafeModel(
  aiModel: string,
  envModel: string | undefined,
): string {
  const configured = aiModel.trim();
  if (configured.toLowerCase().startsWith('jev')) {
    return configured;
  }
  const fromEnv = (envModel ?? '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_TYPESAFE_MODEL;
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
export function reconcileKindLabels(
  keptKindLabels: readonly string[],
  candidates: readonly string[],
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

function unique(labels: readonly string[]): string[] {
  return [...new Set(labels)];
}

function labelDescription(
  label: ClassifiedLabel,
  maxLength: number,
): string | null {
  const description = label.description.trim().slice(0, maxLength);
  return description.length > 0 ? description : null;
}

function labelCategory(name: string): string | null {
  const slash = name.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  return name.slice(0, slash);
}

/**
 * A key that is not itself a label name, so "none of these" cannot collide with a
 * repository label that happens to be called `none`.
 */
export function noneOptionKey(labelNames: readonly string[]): string {
  const taken = new Set(labelNames);
  const candidates = ['none', '__none__', '__no_kind_label__'];
  for (const candidate of candidates) {
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  let suffix = 0;
  while (taken.has(`__no_kind_label_${suffix}__`)) {
    suffix += 1;
  }
  return `__no_kind_label_${suffix}__`;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Prefer labels the pull request already has, so a capped question set can still correct
 * them, then labels the workflow requires, then the rest in repository order.
 */
function rankLabels(
  labels: readonly ClassifiedLabel[],
  currentLabels: ReadonlySet<string>,
  preferredPrefixes: readonly string[],
): ClassifiedLabel[] {
  return labels
    .map((label, index) => ({ label, index }))
    .sort((left, right) => {
      const rank = (name: string): number => {
        if (currentLabels.has(name)) return 0;
        if (preferredPrefixes.some((prefix) => name.startsWith(prefix)))
          return 1;
        if (name.includes('/')) return 2;
        return 3;
      };
      const byRank = rank(left.label.name) - rank(right.label.name);
      return byRank !== 0 ? byRank : left.index - right.index;
    })
    .map((entry) => entry.label);
}

function dedupeLabels(labels: readonly ClassifiedLabel[]): ClassifiedLabel[] {
  const seen = new Set<string>();
  const result: ClassifiedLabel[] = [];
  for (const label of labels) {
    const name = label.name.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push({ name, description: label.description });
  }
  return result;
}

export function buildClassificationRequest(
  subject: ClassificationSubject,
  labels: readonly ClassifiedLabel[],
  currentLabels: readonly string[],
  preferredPrefixes: readonly string[],
  limits: ClassificationLimits = DEFAULT_CLASSIFICATION_LIMITS,
): ClassificationRequest | null {
  const repositoryLabels = dedupeLabels(labels);
  const current = new Set(currentLabels);

  const kindPool = repositoryLabels.filter((label) => isKindLabel(label.name));
  const rankedKind = rankLabels(kindPool, current, preferredPrefixes);
  const kindLabels = rankedKind.slice(0, limits.maxKindOptions);
  const omittedKind = rankedKind.length - kindLabels.length;

  const noulPool = repositoryLabels.filter((label) => !isKindLabel(label.name));
  const rankedNoul = rankLabels(noulPool, current, preferredPrefixes);
  const noulSelection = rankedNoul.slice(0, limits.maxNoulQuestions);
  const omittedNoul = rankedNoul.length - noulSelection.length;

  if (kindLabels.length === 0 && noulSelection.length === 0) {
    return null;
  }

  const noneKey = noneOptionKey(kindLabels.map((label) => label.name));
  const questions: Questions = emptyRecord<Questions[string]>();

  if (kindLabels.length > 0) {
    const criteria = emptyRecord<string | null>();
    for (const label of kindLabels) {
      criteria[label.name] = labelDescription(label, limits.descriptionLength);
    }
    criteria[noneKey] = 'None of these kind/ labels apply';
    questions[KIND_QUESTION_ID] = choice(
      {
        question:
          'Which single kind/ label best describes what this pull request is for?',
        judge: '`title`, `description`, and `changed_files`',
        focus:
          'Judge the purpose of the change, not incidental files it touches. A feature that happens to touch a lock file is still a feature. A title beginning with feat: or fix: is a strong statement of author intent.',
        none: `Choose ${noneKey} when no kind/ label fits.`,
      },
      criteria,
    );
  }

  for (const label of noulSelection) {
    questions[appliesQuestionId(label.name)] = noul(
      {
        question: 'Does `label` apply to this pull request?',
        label: {
          name: label.name,
          description: labelDescription(label, limits.descriptionLength),
          category: labelCategory(label.name),
        },
        focus:
          'Judge what the change is for. Incidental files, such as a lock file touched by a feature, do not by themselves make a label apply.',
      },
      {
        true: 'The label accurately describes this change and belongs on the pull request',
        false: 'The label does not describe this change',
      },
    );
  }

  return {
    state: {
      title: subject.title,
      description: subject.description,
      head: subject.head,
      base: subject.base,
      changed_files: subject.changedFiles.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      })),
      omitted_file_count: subject.omittedFileCount,
    },
    questions,
    kindLabels: kindLabels.map((label) => label.name),
    noneKey,
    noulLabels: noulSelection.map((label) => label.name),
    omittedKind,
    omittedNoul,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ParsedAnswer {
  type: string;
  choice: string | null;
  confidence: number | null;
  noul: number | null;
}

function parseAnswer(value: unknown): ParsedAnswer | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  return {
    type: value.type,
    choice: typeof value.choice === 'string' ? value.choice : null,
    confidence: readNumber(value.confidence),
    noul: readNumber(value.noul),
  };
}

function answerMap(answers: unknown): Map<string, ParsedAnswer> {
  const parsed = new Map<string, ParsedAnswer>();
  if (!isRecord(answers)) {
    return parsed;
  }
  for (const [key, value] of Object.entries(answers)) {
    const answer = parseAnswer(value);
    if (answer) {
      parsed.set(key, answer);
    }
  }
  return parsed;
}

function quote(label: string): string {
  return `\`${label}\``;
}

function formatList(labels: readonly string[]): string {
  return labels.map(quote).join(', ');
}

/**
 * Turns Jev's answers into label additions and removals.
 *
 * A kind Choice replaces the other kind labels on the pull request. A Noul adds at
 * {@link NOUL_APPLY_THRESHOLD} and removes at {@link NOUL_REMOVE_THRESHOLD}. Answers
 * outside those bounds, or that name an option we did not ask, change nothing.
 */
export function interpretClassification(args: {
  model: string;
  answers: unknown;
  kindLabels: readonly string[];
  noneKey: string;
  noulLabels: readonly string[];
  currentLabels: readonly string[];
}): LabelClassification {
  const answers = answerMap(args.answers);
  const current = new Set(args.currentLabels);
  const labelsToAdd: string[] = [];
  const labelsToRemove: string[] = [];
  const notes: string[] = [];
  const model = args.model.trim() || DEFAULT_TYPESAFE_MODEL;

  if (args.kindLabels.length > 0) {
    const answer = answers.get(KIND_QUESTION_ID);
    const offered = new Set(args.kindLabels);
    if (
      !answer ||
      answer.type !== 'choice' ||
      answer.choice === null ||
      answer.confidence === null
    ) {
      notes.push('Left kind/ unchanged because Jev returned no usable choice.');
    } else if (answer.confidence < CHOICE_CONFIDENCE_THRESHOLD) {
      notes.push(
        `Left kind/ unchanged (confidence ${answer.confidence.toFixed(2)} is below ${CHOICE_CONFIDENCE_THRESHOLD.toFixed(2)}).`,
      );
    } else if (answer.choice === args.noneKey) {
      const removable = args.currentLabels.filter((label) =>
        offered.has(label),
      );
      labelsToRemove.push(...removable);
      notes.push(
        removable.length > 0
          ? `No kind/ label applies (confidence ${answer.confidence.toFixed(2)}). Removing ${formatList(removable)}.`
          : `No kind/ label applies (confidence ${answer.confidence.toFixed(2)}).`,
      );
    } else if (!offered.has(answer.choice)) {
      notes.push(
        `Left kind/ unchanged because ${quote(answer.choice)} was not one of the offered labels.`,
      );
    } else {
      if (!current.has(answer.choice)) {
        labelsToAdd.push(answer.choice);
      }
      const siblings = args.currentLabels.filter(
        (label) => offered.has(label) && label !== answer.choice,
      );
      labelsToRemove.push(...siblings);
      const confidence = answer.confidence.toFixed(2);
      if (siblings.length > 0) {
        notes.push(
          `kind/ is ${quote(answer.choice)} (confidence ${confidence}), replacing ${formatList(siblings)}.`,
        );
      } else if (current.has(answer.choice)) {
        notes.push(
          `${quote(answer.choice)} already applied (confidence ${confidence}).`,
        );
      } else {
        notes.push(
          `kind/ is ${quote(answer.choice)} (confidence ${confidence}).`,
        );
      }
    }
  }

  const applied: string[] = [];
  const cleared: string[] = [];
  const uncertain: string[] = [];

  for (const label of args.noulLabels) {
    const answer = answers.get(appliesQuestionId(label));
    if (!answer || answer.type !== 'noul' || answer.noul === null) {
      uncertain.push(label);
      continue;
    }
    if (answer.noul >= NOUL_APPLY_THRESHOLD) {
      if (!current.has(label)) {
        labelsToAdd.push(label);
        applied.push(`${quote(label)} (${answer.noul.toFixed(2)})`);
      }
      continue;
    }
    if (answer.noul <= NOUL_REMOVE_THRESHOLD && current.has(label)) {
      labelsToRemove.push(label);
      cleared.push(`${quote(label)} (${answer.noul.toFixed(2)})`);
      continue;
    }
    uncertain.push(label);
  }

  if (applied.length > 0) {
    notes.push(`Applying ${applied.slice(0, 12).join(', ')}.`);
  }
  if (cleared.length > 0) {
    notes.push(`Removing ${cleared.slice(0, 12).join(', ')}.`);
  }
  if (uncertain.length > 0) {
    notes.push(
      `Left ${uncertain.length} label${uncertain.length === 1 ? '' : 's'} unchanged where the answer was uncertain.`,
    );
  }

  if (
    labelsToAdd.length === 0 &&
    labelsToRemove.length === 0 &&
    notes.length === 0
  ) {
    notes.push('No label changes.');
  }

  return {
    labelsToAdd,
    labelsToRemove,
    reasoning: `TypeSafe Jev (${model}): ${notes.join(' ')}`,
  };
}

/**
 * Removes that would leave a configured requirement unmet are refused.
 *
 * An addition counts. Replacing `kind/bug` with `kind/feature` still satisfies a
 * `kind/` requirement, so the old label may go. Removing the last label that satisfies
 * a requirement, with nothing taking its place, is refused. `required_labels_all` is
 * kept label by label.
 */
export function applyPolicyToRemovals(
  currentLabels: readonly string[],
  requestedRemovals: readonly string[],
  additions: readonly string[],
  policy: LabelPolicy,
): { removals: string[]; refused: string[] } {
  const pending = new Set(
    requestedRemovals.filter((label) => currentLabels.includes(label)),
  );
  const refused: string[] = [];

  const refuse = (label: string): void => {
    if (pending.delete(label)) {
      refused.push(label);
    }
  };

  const endState = (): string[] => {
    const kept = currentLabels.filter((label) => !pending.has(label));
    return [...kept, ...additions.filter((label) => !kept.includes(label))];
  };

  for (const label of policy.requiredAll) {
    if (pending.has(label)) {
      refuse(label);
    }
  }

  if (
    policy.requiredAny.length > 0 &&
    !endState().some((label) => policy.requiredAny.includes(label))
  ) {
    const keep = currentLabels.find(
      (label) => pending.has(label) && policy.requiredAny.includes(label),
    );
    if (keep) {
      refuse(keep);
    }
  }

  for (const prefix of policy.requiredPrefixes) {
    if (!prefix) {
      continue;
    }
    const satisfies = (label: string): boolean => label.startsWith(prefix);
    if (!endState().some(satisfies)) {
      const keep = currentLabels.find(
        (label) => pending.has(label) && satisfies(label),
      );
      if (keep) {
        refuse(keep);
      }
    }
  }

  return {
    removals: requestedRemovals.filter(
      (label) => pending.has(label) && currentLabels.includes(label),
    ),
    refused,
  };
}

/**
 * Kind exclusivity and the label policy decide together.
 *
 * Allowing a removal because a kind label will be added, then dropping that addition
 * because another kind label survived, would strip the requirement the addition was
 * supposed to cover. Each pass recomputes the additions that exclusivity still allows
 * and refuses any removal those additions no longer justify.
 */
export function planLabelEdits(
  currentLabels: readonly string[],
  requestedAdds: readonly string[],
  requestedRemovals: readonly string[],
  policy: LabelPolicy,
): PlannedLabelEdits {
  const current = unique(currentLabels);
  const requestedRemovalList = unique(requestedRemovals).filter((label) =>
    current.includes(label),
  );
  const banned = new Set(policy.banned);
  const adds = unique(requestedAdds).filter(
    (label) =>
      !current.includes(label) &&
      !requestedRemovalList.includes(label) &&
      !banned.has(label),
  );
  const refused = new Set<string>();

  const compute = (): PlannedLabelEdits & { newlyRefused: string[] } => {
    const removing = new Set(
      requestedRemovalList.filter((label) => !refused.has(label)),
    );
    const survivingKind = current.filter(
      (label) => isKindLabel(label) && !removing.has(label),
    );
    const { accepted, rejected } = reconcileKindLabels(
      survivingKind,
      adds.filter(isKindLabel),
    );
    const acceptedKind = new Set(accepted);
    const labelsToAdd = adds.filter(
      (label) => !isKindLabel(label) || acceptedKind.has(label),
    );
    const policyResult = applyPolicyToRemovals(
      current,
      [...removing],
      labelsToAdd,
      policy,
    );
    return {
      labelsToAdd,
      labelsToRemove: policyResult.removals,
      refusedRemovals: [],
      rejectedKindLabels: rejected,
      newlyRefused: policyResult.refused,
    };
  };

  let planned = compute();
  for (let attempt = 0; attempt < requestedRemovalList.length; attempt++) {
    if (planned.newlyRefused.length === 0) {
      break;
    }
    let grew = false;
    for (const label of planned.newlyRefused) {
      if (!refused.has(label)) {
        refused.add(label);
        grew = true;
      }
    }
    if (!grew) {
      break;
    }
    planned = compute();
  }

  return {
    labelsToAdd: planned.labelsToAdd,
    labelsToRemove: planned.labelsToRemove,
    refusedRemovals: [...refused],
    rejectedKindLabels: planned.rejectedKindLabels,
  };
}

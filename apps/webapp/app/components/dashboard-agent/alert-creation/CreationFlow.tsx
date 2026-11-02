import type { AlertCreatedBlock } from "@internal/dashboard-agent-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALERT_NAME_MAX,
  capabilityParams,
  conditionKindFor,
  isLimitCondition,
  defaultWindowMinutes,
  compositeComponents,
  draftMissing,
  isComplete,
  needsScopeValue,
  promptForStep,
  labelFor,
  resolveCapability,
  skipsScope,
  STEP_ORDER,
  withAutoAnswers,
  type FlowAnswers,
  type FlowStepKey,
} from "./flow-state";

function shouldSkipCondition(what: string | undefined): boolean {
  const kind = conditionKindFor(what);
  if (kind === "threshold" || kind === "absence") return false;
  return !isLimitCondition(what) && capabilityParams(what).length === 0;
}

function skipsStep(key: FlowStepKey | undefined, answers: FlowAnswers): boolean {
  if (key === "condition") return shouldSkipCondition(answers.what);
  if (key === "scope") return skipsScope(answers);
  if (key === "environments" || key === "name") return !answers.replace;
  return false;
}

function stepAfter(key: FlowStepKey, answers: FlowAnswers): number {
  const missing = draftMissing(answers);
  for (let i = STEP_ORDER.indexOf(key) + 1; i < STEP_ORDER.length; i++) {
    const next = STEP_ORDER[i]!;
    if (next === "notifiers") return i;
    if (skipsStep(next, answers)) continue;
    if (missing.includes(next)) return i;
  }
  return STEP_ORDER.length;
}

export type CreationFlowState = {
  answers: FlowAnswers;
  currentStep: FlowStepKey | undefined;
  completedSteps: { key: FlowStepKey; prompt: string; label: string }[];
  isReview: boolean;
  created: boolean;
  createdAlertId: string | undefined;
  createdBlock?: AlertCreatedBlock;
  submitting: boolean;
  submitError: boolean;
  selectChip: (key: FlowStepKey, value: string) => void;
  setCondition: (value: string) => void;
  setConditionParams: (params: Record<string, number> | undefined) => void;
  updateAnswers: (patch: Partial<FlowAnswers>) => void;
  confirmWhat: (what: string, components?: string[]) => void;
  setName: (name: string) => void;
  confirmName: () => void;
  confirmCondition: () => void;
  setScopeValue: (value: string) => void;
  setWindowMinutes: (value: number) => void;
  toggleNotifier: (value: string) => void;
  confirmNotifiers: () => void;
  setExpiry: (value: string) => void;
  create: () => void;
  reset: () => void;
  patchAnswers: (next: FlowAnswers) => void;
};

function initialStepIndex(answers: FlowAnswers): number {
  for (let i = 0; i < STEP_ORDER.length; i++) {
    const key = STEP_ORDER[i]!;
    if (key === "notifiers") {
      if (answers.expiry === undefined) return i;
      continue;
    }
    if (key === "name") {
      if (!answers.replace && answers.name !== undefined && !answers.nameConfirmed) return i;
      continue;
    }
    if (key === "environments") {
      if (answers.replace && (!answers.environmentsConfirmed || !answers.environments?.length))
        return i;
      continue;
    }
    if (skipsStep(key, answers)) continue;
    if (key === "condition" && isLimitCondition(answers.what)) {
      if (
        !answers.conditionConfirmed &&
        answers.signals === undefined &&
        answers.compositeMode === undefined
      ) {
        return i;
      }
      continue;
    }
    if (answers[key as keyof FlowAnswers] === undefined) return i;
  }
  return STEP_ORDER.length;
}

export type CreationResult = boolean | { alertId: string; block?: AlertCreatedBlock } | void;

export function extractAlertId(result: CreationResult): string | undefined {
  if (typeof result === "object" && result !== null && "alertId" in result) {
    return result.alertId;
  }
  return undefined;
}

export function useCreationFlowState(
  onSubmit?: (answers: FlowAnswers) => CreationResult | Promise<CreationResult>,
  initialAnswers?: FlowAnswers,
  resetKey?: number
): CreationFlowState {
  const [answers, setAnswers] = useState<FlowAnswers>(() => withAutoAnswers(initialAnswers ?? {}));
  const [stepIndex, setStepIndex] = useState(() =>
    initialStepIndex(withAutoAnswers(initialAnswers ?? {}))
  );
  const [created, setCreated] = useState(false);
  const [createdAlertId, setCreatedAlertId] = useState<string | undefined>(undefined);
  const [createdBlock, setCreatedBlock] = useState<AlertCreatedBlock | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submitGeneration = useRef(0);
  const [submitError, setSubmitError] = useState(false);

  const initialAnswersRef = useRef(initialAnswers);
  useEffect(() => {
    initialAnswersRef.current = initialAnswers;
  }, [initialAnswers]);
  const appliedKeyRef = useRef(resetKey);
  useEffect(() => {
    if (resetKey !== undefined && resetKey !== appliedKeyRef.current) {
      appliedKeyRef.current = resetKey;
      submitGeneration.current++;
      const fresh = withAutoAnswers(initialAnswersRef.current ?? {});
      setAnswers(fresh);
      setStepIndex(initialStepIndex(fresh));
      setCreated(false);
      setCreatedAlertId(undefined);
      setCreatedBlock(undefined);
      setSubmitting(false);
      submittingRef.current = false;
      setSubmitError(false);
    }
  }, [resetKey]);

  const currentStep = stepIndex < STEP_ORDER.length ? STEP_ORDER[stepIndex] : undefined;
  const isReview = !created && stepIndex >= STEP_ORDER.length;

  // Removed: auto-advance effect was causing state conflicts

  const completedSteps = useMemo(
    () =>
      STEP_ORDER.slice(0, stepIndex)
        .filter((key) => answers[key] !== undefined)
        .map((key) => ({
          key,
          prompt: promptForStep(key, answers),
          label:
            key === "what" && answers.components
              ? answers.components
                  .map((component) => resolveCapability(component)?.title ?? component)
                  .join(", ")
              : key === "notifiers" || key === "environments"
                ? (answers[key] ?? []).join(", ")
                : labelFor(key, answers[key] as string, answers),
        })),
    [stepIndex, answers]
  );

  const selectChip = useCallback(
    (key: FlowStepKey, value: string) => {
      if (key === "notifiers") return;
      const index = STEP_ORDER.indexOf(key);
      const a = answers;
      const base: FlowAnswers = {};
      for (const stepKey of STEP_ORDER.slice(0, index)) {
        if (stepKey !== "environments") (base as Record<string, unknown>)[stepKey] = a[stepKey];
      }
      (base as Record<string, unknown>)[key] = value;
      const carryScope =
        key === "what" &&
        a.scope !== undefined &&
        resolveCapability(value)?.allowedScopes.includes(a.scope as never);
      const built = withAutoAnswers({
        ...base,
        ...(carryScope ? { scope: a.scope } : {}),
        ...(key === "scope"
          ? {
              condition: a.condition,
              conditionParams: a.conditionParams,
              compositeMode: a.compositeMode,
              signals: a.signals,
              conditionConfirmed: a.conditionConfirmed,
              name: a.name,
              components: a.components,
            }
          : {}),
        notifiers: a.notifiers,
        scopeValue: key === "scope" ? undefined : a.scopeValue,
        windowMinutes: key === "what" || key === "area" ? undefined : a.windowMinutes,
        expiry: a.expiry,
        ...(a.replace
          ? {
              replace: a.replace,
              environments: a.environments,
              environmentsConfirmed: a.environmentsConfirmed,
              previewsExpanded: a.previewsExpanded,
            }
          : {}),
      });
      setAnswers(built);
      if (key === "scope" && needsScopeValue(value)) {
        setStepIndex(index);
        setCreated(false);
        return;
      }
      let nextIdx = index + 1;
      while (nextIdx < STEP_ORDER.length && skipsStep(STEP_ORDER[nextIdx], built)) nextIdx++;
      setStepIndex(nextIdx);
      setCreated(false);
    },
    [answers]
  );

  const setCondition = useCallback((value: string) => {
    setAnswers((prev) => {
      const kind = conditionKindFor(prev.what);
      const win = kind === "threshold" ? defaultWindowMinutes(prev.what) : undefined;
      const next = { ...prev, condition: value, windowMinutes: prev.windowMinutes ?? win };
      setStepIndex((i) => Math.max(i, stepAfter("condition", next)));
      return next;
    });
  }, []);

  const setScopeValue = useCallback((value: string) => {
    setAnswers((prev) => {
      const next = { ...prev, scopeValue: value };
      setStepIndex((i) => Math.max(i, stepAfter("scope", next)));
      return next;
    });
  }, []);

  const setWindowMinutes = useCallback((value: number) => {
    setAnswers((prev) => {
      const next = { ...prev, windowMinutes: value };
      setStepIndex((i) => Math.max(i, stepAfter("condition", next)));
      return next;
    });
  }, []);

  const setConditionParams = useCallback((params: Record<string, number> | undefined) => {
    setAnswers((prev) => ({ ...prev, conditionParams: params }));
  }, []);

  const updateAnswers = useCallback((patch: Partial<FlowAnswers>) => {
    setAnswers((prev) => ({ ...prev, ...patch }));
  }, []);

  const confirmWhat = useCallback(
    (what: string, components?: string[]) => {
      selectChip("what", what);
      setAnswers((prev) => ({ ...prev, components, picked: undefined }));
    },
    [selectChip]
  );

  const confirmCondition = useCallback(() => {
    setStepIndex((i) => Math.max(i, stepAfter("condition", answers)));
  }, [answers]);

  const toggleNotifier = useCallback((value: string) => {
    setAnswers((a) => {
      const existing = a.notifiers ?? [];
      const next = existing.includes(value)
        ? existing.filter((v) => v !== value)
        : [...existing, value];
      return { ...a, notifiers: next };
    });
  }, []);

  const confirmNotifiers = useCallback(() => {
    if ((answers.notifiers ?? []).length === 0) return;
    const missing = draftMissing(answers)[0];
    const toName = !missing && !answers.replace && !answers.nameConfirmed;
    setStepIndex(
      missing
        ? STEP_ORDER.indexOf(missing)
        : toName
          ? STEP_ORDER.indexOf("name")
          : STEP_ORDER.length
    );
  }, [answers]);

  const setName = useCallback((name: string) => {
    setAnswers((prev) => ({ ...prev, name: name.slice(0, ALERT_NAME_MAX) }));
  }, []);

  const confirmName = useCallback(() => {
    if (answers.name !== undefined && !answers.name.trim()) return;
    setAnswers((prev) => ({ ...prev, nameConfirmed: true }));
    setStepIndex(STEP_ORDER.length);
  }, [answers.name]);

  const setExpiry = useCallback((value: string) => {
    setAnswers((a) => ({ ...a, expiry: value }));
  }, []);

  const create = useCallback(async () => {
    if (!isComplete(answers) || submittingRef.current) return;
    submittingRef.current = true;
    const generation = submitGeneration.current;
    setSubmitting(true);
    setSubmitError(false);
    try {
      const resolved = await onSubmit?.(answers);
      if (submitGeneration.current !== generation) return;
      if (resolved === false) {
        setSubmitError(true);
        return;
      }
      const id = extractAlertId(resolved);
      if (id) setCreatedAlertId(id);
      if (typeof resolved === "object" && resolved?.block) setCreatedBlock(resolved.block);
      setCreated(true);
    } finally {
      if (submitGeneration.current === generation) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }, [answers, onSubmit]); // eslint-disable-line -- answers is read by isComplete and passed to onSubmit

  const reset = useCallback(() => {
    submitGeneration.current++;
    setAnswers({});
    setStepIndex(0);
    setCreated(false);
    setCreatedAlertId(undefined);
    setCreatedBlock(undefined);
    submittingRef.current = false;
    setSubmitting(false);
    setSubmitError(false);
  }, []);

  const patchAnswers = useCallback((raw: FlowAnswers) => {
    const next = withAutoAnswers(raw);
    setAnswers(next);
    setStepIndex(initialStepIndex(next));
  }, []);

  return {
    answers,
    currentStep,
    completedSteps,
    isReview,
    created,
    createdAlertId,
    createdBlock,
    submitting,
    submitError,
    selectChip,
    setCondition,
    setConditionParams,
    updateAnswers,
    confirmWhat,
    setName,
    confirmName,
    confirmCondition,
    setScopeValue,
    setWindowMinutes,
    toggleNotifier,
    confirmNotifiers,
    setExpiry,
    create,
    reset,
    patchAnswers,
  };
}

export type AlertChannel = { id: string; name: string; type: string };

export function notifyLabel(answers: FlowAnswers, channels: AlertChannel[]): string {
  const selected = answers.notifiers ?? [];
  const parts: string[] = [];
  if (selected.includes("chat")) parts.push("this chat");
  for (const id of selected) {
    if (id === "chat") continue;
    const ch = channels.find((c) => c.id === id);
    parts.push(ch ? ch.name : id);
  }
  return parts.join(", ") || "None";
}

export function useDefaultComponents(flow: CreationFlowState, hiddenAreas: string[]) {
  const { answers, updateAnswers } = flow;
  const hidden = hiddenAreas.join(",");
  useEffect(() => {
    if (answers.what !== "limits.all") return;
    const offered = compositeComponents("limits.all", hidden ? hidden.split(",") : []);
    const next = (answers.components ?? offered).filter((key) => offered.includes(key));
    if (next.length !== answers.components?.length) updateAnswers({ components: next });
  }, [answers.what, answers.components, hidden, updateAnswers]);
}

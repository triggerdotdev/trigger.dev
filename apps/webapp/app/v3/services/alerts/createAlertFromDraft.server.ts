import {
  conditionSchema,
  getCapability,
  isScopeAllowed,
  notifierRefKey,
  notifierRefSchema,
  validateConditionParams,
  type Condition,
  type NotifierRef,
} from "@internal/alert-contracts";
import { parseErrorGroupScope } from "~/utils/errorGroupScope";
import type { PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { querySchemas } from "~/v3/querySchemas";
import {
  analyzeQueryForAlert,
  queryWindowIssue,
  suggestQueryAlertName,
  toQuerySignal,
  type QueryAlertChoice,
} from "./queryAlerts/analyzeQueryForAlert.server";
import { createAlertAndSchedule, type AlertLifecycleDeps } from "./alertLifecycle.server";
import { type AlertDraftScope } from "./alertDraft";
import { absenceWindowFloor, absenceWindowMessage } from "./validateAlertDraft.server";
import type { Alert } from "./storage/alertStore.server";

export type { AlertDraftScope };

export type CreateAlertFromDraftParams = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  capabilityKey: string;
  scope: AlertDraftScope;
  condition: Condition;
  expiresAt?: Date;
  notifiers: NotifierRef[];
  createdBy: string;
  name?: string;
  query?: string;
  querySignalChoice?: QueryAlertChoice;
};

const QUERY_CAPABILITY_KEY = "custom.query";
const KIND_FOR_MODE = { threshold: "threshold", absence: "absence", match: "occurrence" } as const;

export class UnknownCapabilityError extends Error {
  constructor(capabilityKey: string) {
    super(`Unknown capability: ${capabilityKey}`);
  }
}

export class IncompatibleAlertKindError extends Error {
  constructor(kind: string, capabilityKey: string) {
    super(`"${kind}" is not a valid condition for ${capabilityKey}`);
  }
}

export class AbsenceWindowTooShortError extends Error {
  constructor(public readonly minWindowSec: number) {
    super(absenceWindowMessage(minWindowSec));
  }
}

export class InvalidScopeForCapabilityError extends Error {
  constructor(scopeType: string, capabilityKey: string, message?: string) {
    super(message ?? `"${scopeType}" scope is not valid for ${capabilityKey}`);
  }
}

export class NoNotifiersError extends Error {
  constructor() {
    super("At least one notifier is required");
  }
}

export class InvalidNotifierError extends Error {
  constructor() {
    super("Invalid notifier");
  }
}

export class IncompleteChatNotifierError extends Error {
  constructor() {
    super("A chat notifier needs a conversation to deliver to");
  }
}

export class InvalidQueryAlertError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidConditionParamsError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const QUERY_DOMAIN_ERRORS = [
  UnknownCapabilityError,
  IncompatibleAlertKindError,
  AbsenceWindowTooShortError,
  InvalidConditionParamsError,
  InvalidScopeForCapabilityError,
  NoNotifiersError,
  IncompleteChatNotifierError,
  InvalidNotifierError,
];

/** Checks a draft against the capability registry and returns the parsed condition. */
export function assertAlertDraftValid(
  params: Pick<CreateAlertFromDraftParams, "capabilityKey" | "condition" | "notifiers"> & {
    scope: { type: AlertDraftScope["type"] };
  }
): Condition {
  const capability = getCapability(params.capabilityKey);
  if (!capability) {
    throw new UnknownCapabilityError(params.capabilityKey);
  }

  if (!capability.allowedKinds.includes(params.condition.kind)) {
    throw new IncompatibleAlertKindError(params.condition.kind, params.capabilityKey);
  }

  if (!isScopeAllowed(capability, params.scope.type)) {
    throw new InvalidScopeForCapabilityError(params.scope.type, params.capabilityKey);
  }

  const minWindowSec = absenceWindowFloor(capability);
  if (params.condition.kind === "absence" && minWindowSec !== undefined) {
    if (params.condition.quietWindowSec < minWindowSec) {
      throw new AbsenceWindowTooShortError(minWindowSec);
    }
  }

  if (params.notifiers.length === 0) {
    throw new NoNotifiersError();
  }
  for (const notifier of params.notifiers) {
    if (notifier.type === "chat" && !notifier.chatId?.trim()) {
      throw new IncompleteChatNotifierError();
    }
    if (!notifierRefSchema.safeParse(notifier).success) {
      throw new InvalidNotifierError();
    }
  }

  if (
    params.condition.kind === "state" &&
    params.condition.params &&
    Object.keys(params.condition.params).length > 0
  ) {
    try {
      validateConditionParams(params.condition.params, capability.binding.params ?? []);
    } catch (e) {
      throw new InvalidConditionParamsError(e instanceof Error ? e.message : String(e));
    }
  }

  // Applies numeric bounds (e.g. windowSec > 0) in addition to the shape check above.
  return conditionSchema.parse(params.condition);
}

function deriveQueryAlert(params: CreateAlertFromDraftParams, condition: Condition) {
  const query = params.query?.trim();
  if (!query) throw new InvalidQueryAlertError("A query is required");
  const choice = params.querySignalChoice;
  if (!choice) throw new InvalidQueryAlertError("Choose how the query should alert");

  const analysis = analyzeQueryForAlert(query, {
    tableSchemas: querySchemas,
    flags: { QUEUE_METRICS: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1" },
  });
  const result = toQuerySignal(analysis, choice);
  if (!result.ok) {
    const reason = analysis.ok
      ? analysis.unsupported.find((u) => u.mode === choice.mode)?.message
      : (analysis.errors[0]?.message ?? analysis.unsupported[0]?.message);
    throw new InvalidQueryAlertError(reason ?? result.message);
  }

  if (condition.kind !== KIND_FOR_MODE[choice.mode]) {
    throw new InvalidQueryAlertError(
      `"${condition.kind}" condition doesn't match the "${choice.mode}" mode`
    );
  }

  const windowSec =
    condition.kind === "threshold"
      ? condition.windowSec
      : condition.kind === "absence"
        ? condition.quietWindowSec
        : undefined;
  const windowIssue = windowSec === undefined ? undefined : queryWindowIssue(analysis, windowSec);
  if (windowIssue) throw new InvalidQueryAlertError(windowIssue);

  return {
    query,
    querySignal: result.signal,
    name: params.name ?? suggestQueryAlertName(analysis, choice),
  };
}

export function uniqueNotifiers(notifiers: NotifierRef[]): NotifierRef[] {
  const seen = new Set<string>();
  return notifiers.filter((notifier) => {
    const key = notifierRefKey(notifier);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Validates a draft against the capability registry (kind allowed, absence window floor)
 * and creates the Alert row. Kept separate from the route so it can be tested against a
 * real Postgres without a session/HTTP stack.
 */
export async function createAlertFromDraft(
  db: PrismaClientOrTransaction,
  params: CreateAlertFromDraftParams,
  deps?: AlertLifecycleDeps
): Promise<Alert> {
  const condition = assertAlertDraftValid(params);
  const derived =
    params.capabilityKey === QUERY_CAPABILITY_KEY ? deriveQueryAlert(params, condition) : undefined;

  return createAlertAndSchedule(
    db,
    {
      organizationId: params.organizationId,
      projectId: params.projectId,
      environmentId: params.environmentId,
      capabilityKey: params.capabilityKey,
      params: {
        environmentId: params.environmentId,
        scope: params.scope,
        ...(derived && { querySignal: derived.querySignal }),
      },
      condition,
      expiresAt: params.expiresAt,
      notifiers: uniqueNotifiers(params.notifiers),
      createdBy: params.createdBy,
      name: derived?.name ?? params.name,
      ...(derived && { query: derived.query }),
    },
    deps
  );
}

export type AlertDraftPrefill = {
  capabilityKey?: string;
  scope?: AlertDraftScope;
};

/**
 * Reads the contextual-creation query params (DEC-091: capability, scope, scopeValue) into
 * a draft prefill. Env is never read from the query string — it's always the current route env.
 */
export function resolveAlertDraftPrefill(searchParams: {
  capability?: string;
  scope?: "queue" | "queuePattern" | "task" | "all" | "errorGroup";
  scopeValue?: string;
}): AlertDraftPrefill {
  const capabilityKey = searchParams.capability;

  if (!searchParams.scope) {
    return { capabilityKey };
  }

  if (searchParams.scope === "all") {
    return { capabilityKey, scope: { type: "all" } };
  }

  if (!searchParams.scopeValue) {
    return { capabilityKey };
  }

  switch (searchParams.scope) {
    case "queue":
      return { capabilityKey, scope: { type: "queue", queue: searchParams.scopeValue } };
    case "queuePattern":
      return { capabilityKey, scope: { type: "queuePattern", pattern: searchParams.scopeValue } };
    case "task":
      return {
        capabilityKey,
        scope: { type: "task", taskIdentifier: searchParams.scopeValue },
      };
    case "errorGroup": {
      const group = parseErrorGroupScope(searchParams.scopeValue);
      return group ? { capabilityKey, scope: group } : { capabilityKey };
    }
  }
}

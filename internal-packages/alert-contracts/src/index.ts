export {
  alertAreaSchema,
  alertSignalSchema,
  alertKindSchema,
  alertUnitSchema,
  alertSurfaceSchema,
  alertFreshnessSchema,
  capabilityParamSchema,
  queryBindingSchema,
  alertBindingSchema,
  alertCapabilitySchema,
  conditionSchema,
  evaluationOutcomeSchema,
  occurrenceSchema,
  occurrenceExpiresAt,
  evaluationResultSchema,
  alertLifecycleSchema,
  alertAttentionSchema,
  observedConditionSchema,
  alertEventTypeSchema,
  alertDeliveryStatusSchema,
  behaviorSchema,
  alertParamsSchema,
  querySignalSchema,
  notifierRefSchema,
  notifierRefKey,
  alertScopeTypeSchema,
  isScopeAllowed,
  ScopeNotAllowedError,
  compileTemplate,
  validateConditionParams,
} from "./schemas.js";

export type {
  AlertArea,
  AlertSignal,
  AlertKind,
  AlertUnit,
  AlertSurface,
  AlertFreshness,
  CapabilityParam,
  AlertBinding,
  AlertCapability,
  Condition,
  EvaluationOutcome,
  Occurrence,
  EvaluationResult,
  AlertLifecycle,
  AlertAttention,
  ObservedCondition,
  AlertEventType,
  AlertDeliveryStatus,
  Behavior,
  AlertParams,
  QuerySignal,
  NotifierRef,
  AlertScopeType,
} from "./schemas.js";

export { displayStatus, transition, resolve, expire, stop } from "./transitions.js";

export type {
  DisplayStatus,
  AlertState,
  TransitionInput,
  TransitionOutput,
} from "./transitions.js";

export {
  V1_CAPABILITIES,
  CURRENTLY_QUEUED_PREDICATE_PENDING,
  getCapability,
  listCapabilities,
} from "./registry.js";

export {
  QUERY_SOURCES,
  getQuerySource,
  querySourcesFor,
  minCadenceForTables,
  modesForTables,
} from "./querySources.js";
export type { QueryMode, QuerySource } from "./querySources.js";

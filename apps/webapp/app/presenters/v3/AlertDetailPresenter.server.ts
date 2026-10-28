import {
  firstAlertEventAt,
  getAlert,
  getLatestAlertEventTimes,
  countAlertEventsByType,
  listAlertEvents,
  type Alert,
  type AlertEvent,
} from "~/v3/services/alerts/storage/alertStore.server";
import {
  alertParamsSchema,
  compileTemplate,
  conditionSchema,
  displayStatus,
  getCapability,
  notifierRefKey,
  type AlertParams,
  type Condition,
  type DisplayStatus,
  type NotifierRef,
} from "@internal/alert-contracts";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { conditionSummary, humanizeSeconds } from "~/components/alerts/alertSummaries";
import { limitScopeLabel } from "~/components/alerts/limitSummary";
import { formatExpiresAt } from "~/components/alerts/formatExpiresAt";
import {
  episodeFromTimes,
  episodeStateOutcome,
  type AlertEpisode,
} from "~/components/alerts/alertStateOutcome";
import {
  clickhouseDateTimeLiteral,
  resolveEffectiveParams,
  scopeWhere,
} from "~/v3/services/alerts/evaluators/queryEvaluator.server";
import { BasePresenter } from "./basePresenter.server";
import {
  alertChannelIssues,
  loadNotifierChannels,
  notifierChannelIds,
  type AlertChannelIssue,
  type NotifierChannel,
} from "~/v3/services/alerts/alertChannelIssues.server";
import {
  getCurrentReading,
  type CurrentReading,
  type GetCurrentReadingDeps,
} from "~/v3/services/alerts/engine/currentReading.server";
import { AREA_LABEL } from "~/components/alerts/domainIcons";
import {
  createProductionEvaluateBinding,
  createQueryRowRunner,
} from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import { retryOnConcurrency } from "~/v3/services/alerts/healthQuerySeries.server";
import {
  parseComponentsFromFacts,
  parseEvaluatorStateComponents,
  type FactsComponents,
} from "~/v3/services/alerts/factsComponents";

type AlertDetailNotifier = {
  key: string;
  label: string;
};

export type AlertDetailEvent = {
  id: string;
  type: AlertEvent["type"];
  at: Date;
  actorId: string | null;
  factsSummary: string;
  fingerprint?: string;
  taskIdentifier?: string;
};

export type AlertDetailObjectLink =
  | { kind: "queue"; friendlyId: string; name: string }
  | { kind: "task"; taskIdentifier: string; name: string }
  | { kind: "fingerprint"; fingerprint: string; name: string };

export type AlertDetail = {
  id: string;
  name: string;
  capabilityKey: string;
  capabilityTitle: string;
  capabilityDescription?: string;
  area: string;
  environmentId: string;
  kind: Condition["kind"];
  operator?: ">" | "<";
  thresholdValue?: number;
  scope: AlertParams["scope"];
  scopeSummary: string;
  conditionSummary: string;
  compiledQuery?: string;
  windowSec?: number;
  behaviorSummary: string;
  behaviorLabel: string;
  status: DisplayStatus;
  channelIssues: AlertChannelIssue[];
  evaluated: boolean;
  resolvedByLabel: string | null;
  stoppedByLabel: string | null;
  notifiers: AlertDetailNotifier[];
  events: AlertDetailEvent[];
  latestRaisedEventFacts?: Record<string, unknown>;
  occurrenceSummary?: { lastOccurrenceAt: Date; countSinceRaise: number };
  occurrenceCount: number;
  countSinceRaise?: number;
  firstEventAt?: Date;
  lastEventAt?: Date;
  expiresAt: Date | null;
  unitSuffix: string;
  reading:
    | { kind?: "value"; value: number; threshold?: number }
    | { kind: "lowVolume"; total: number; windowSec?: number }
    | {
        kind: "noData";
        reason?: string;
        windowSec?: number;
        lastRaised?: { value: number; at: Date };
      }
    | { kind: "state"; state: "met" | "not_met" | "unknown"; observedAt: Date }
    | null;
  stateOutcome: "met" | "not_met" | "unavailable" | null;
  episode: AlertEpisode;
  currentReading: CurrentReading;
  objectLink?: AlertDetailObjectLink;
  factsComponents: FactsComponents | null;
  effectiveParams: { key: string; label: string; value: number; unit?: string }[];
};

const UNIT_SUFFIX: Record<string, string> = {
  duration_ms: "ms",
  percent: "%",
  rate_per_hour: "/hr",
};

const MAX_SUMMARY_LENGTH = 120;
const IGNORED_FACT_KEYS = new Set(["observedAt", "bucketSec"]);

function checkpointOf(alert: Alert): Date {
  const stored = alert.evaluatorState?.checkpoint;
  if (typeof stored !== "string" || Number.isNaN(new Date(stored).getTime())) {
    return alert.createdAt;
  }
  return new Date(stored);
}

function unitSuffix(unit: unknown): string {
  return typeof unit === "string" ? (UNIT_SUFFIX[unit] ?? "") : "";
}

function componentsSummary(components: unknown): string {
  if (typeof components !== "object" || components === null) return "";
  return Object.entries(components as Record<string, unknown>)
    .map(([name, component]) => {
      const outcome = (component as { outcome?: unknown } | null)?.outcome;
      return outcome === "met"
        ? `${name} met`
        : outcome === "not_met"
          ? `${name} not met`
          : outcome === "unavailable"
            ? `${name} unavailable`
            : "";
    })
    .filter(Boolean)
    .join(", ");
}

function factsSummary(
  facts: Record<string, unknown> | null | undefined,
  capabilityUnit?: string,
  kind?: Condition["kind"],
  windowSec?: number,
  configuredThreshold?: number
): string {
  if (!facts) return "";
  let summary = "";
  if (facts.components !== undefined) {
    summary = componentsSummary(facts.components);
  } else if (kind === "state") {
    summary = "";
  } else if (kind === "absence") {
    const window = typeof facts.windowSec === "number" ? facts.windowSec : windowSec;
    summary = window ? `No events in ${humanizeSeconds(window)}` : "No events in window";
  } else if (typeof facts.value === "number") {
    const suffix = unitSuffix(facts.unit ?? capabilityUnit);
    summary = `${facts.value}${suffix}`;
    const threshold = typeof facts.threshold === "number" ? facts.threshold : configuredThreshold;
    if (threshold !== undefined) summary += ` vs ${threshold}${suffix}`;
  } else if (typeof facts.taskIdentifier === "string") {
    summary = facts.taskIdentifier;
  } else if (kind !== "occurrence") {
    summary = facts.total === 0 || facts.lowVolume === true ? "No data" : "";
  } else {
    summary = Object.entries(facts)
      .filter(
        ([key, value]) =>
          !IGNORED_FACT_KEYS.has(key) &&
          value !== "" &&
          (typeof value === "string" || typeof value === "number")
      )
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
  }
  return summary.slice(0, MAX_SUMMARY_LENGTH);
}

function readingFor(
  currentReading: CurrentReading,
  kind?: Condition["kind"],
  windowSec?: number,
  latestRaised?: { facts?: Record<string, unknown> | null; at: Date }
): AlertDetail["reading"] {
  if (currentReading.status !== "available" || currentReading.result.kind !== "stateful") {
    return null;
  }
  if (kind === "state") {
    const outcome = currentReading.result.outcome;
    return {
      kind: "state",
      state: outcome === "met" || outcome === "not_met" ? outcome : "unknown",
      observedAt: currentReading.observedAt,
    };
  }
  const facts = currentReading.result.facts;
  if ((currentReading.result.outcome as string) === "unavailable") {
    const raisedValue = latestRaised?.facts?.value;
    return {
      kind: "noData",
      reason: typeof facts?.unavailableReason === "string" ? facts.unavailableReason : undefined,
      windowSec,
      lastRaised:
        typeof raisedValue === "number" && latestRaised
          ? { value: raisedValue, at: latestRaised.at }
          : undefined,
    };
  }
  if (facts?.lowVolume === true || facts?.total === 0) {
    return {
      kind: "lowVolume",
      total: typeof facts.total === "number" ? facts.total : 0,
      windowSec: typeof facts.windowSec === "number" ? facts.windowSec : windowSec,
    };
  }
  if (typeof facts?.value !== "number") return null;
  return {
    value: facts.value,
    threshold: typeof facts.threshold === "number" ? facts.threshold : undefined,
  };
}

function stateOutcomeFor(
  currentReading: CurrentReading,
  episode: AlertEpisode
): AlertDetail["stateOutcome"] {
  if (currentReading.status === "unavailable") return null;
  const outcome = currentReading.result.outcome;
  return episodeStateOutcome(episode) ?? (outcome === "impossible" ? "unavailable" : outcome);
}

function areaLabel(area: string): string {
  return AREA_LABEL[area as keyof typeof AREA_LABEL] ?? area;
}

function scopeDetail(scope: AlertParams["scope"], area: string): string {
  switch (scope.type) {
    case "queue":
      return `Queue ${scope.queue}`;
    case "queuePattern":
      return `Matching ${scope.pattern}`;
    case "task":
      return `Task ${scope.taskIdentifier}`;
    case "all": {
      const label = areaLabel(area);
      if (area === "queues") return "All queues";
      if (area === "runs") return "All tasks";
      return `All ${label.toLowerCase()}`;
    }
    case "errorGroup":
      return `Error ${scope.fingerprint.slice(0, 8)} in ${scope.taskIdentifier}`;
  }
}

function scopeSummary(
  scope: AlertParams["scope"],
  area: string,
  capabilityKey: string,
  components?: string[]
): string {
  const limits = limitScopeLabel(capabilityKey, components);
  return `${areaLabel(area)} · ${limits ?? scopeDetail(scope, area)}`;
}

function latestDate(a: Date | undefined, b: Date | null): Date | undefined {
  if (!a) return b ?? undefined;
  return b && b > a ? b : a;
}

function factString(
  facts: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = facts?.[key];
  return typeof value === "string" ? value : undefined;
}

function eventFingerprint(facts: Record<string, unknown> | null | undefined) {
  return factString(facts, "error_fingerprint") ?? factString(facts, "fingerprint");
}

function eventTaskIdentifier(facts: Record<string, unknown> | null | undefined) {
  return factString(facts, "task_identifier") ?? factString(facts, "taskIdentifier");
}

/** Error evidence: the latest raised event's facts; later occurrences are only counted. */
function errorEvidenceFor(
  events: AlertEvent[]
): Array<{ fingerprint?: string; taskIdentifier?: string; at: Date }> {
  const raised = events.find((event) => event.type === "raised");
  if (!raised) return [];
  return [
    {
      fingerprint: eventFingerprint(raised.facts),
      taskIdentifier: eventTaskIdentifier(raised.facts),
      at: raised.at,
    },
  ];
}

/** Current block for occurrence-kind alerts (§2.7): last occurrence time + count since the raise. */
function occurrenceSummaryFor(alert: {
  lastOccurrenceAt: Date | null;
  occurrencesSinceRaise: number;
}): { lastOccurrenceAt: Date; countSinceRaise: number } | undefined {
  return alert.lastOccurrenceAt
    ? { lastOccurrenceAt: alert.lastOccurrenceAt, countSinceRaise: alert.occurrencesSinceRaise }
    : undefined;
}

function windowSecFor(condition: Condition, alertParams: AlertParams): number | undefined {
  if (condition.kind === "threshold") return condition.windowSec;
  if (condition.kind === "absence") return condition.quietWindowSec;
  return alertParams.windowSec;
}

function extractFactsComponents(
  currentReading: CurrentReading,
  events: AlertEvent[],
  evaluatorState: Record<string, unknown> | null | undefined
): FactsComponents | null {
  if (
    currentReading.status === "available" &&
    currentReading.result.kind === "stateful" &&
    currentReading.result.facts
  ) {
    const live = parseComponentsFromFacts(currentReading.result.facts);
    if (live) return live;
  }
  for (const event of events) {
    if (event.type !== "raised" && event.type !== "recovered") continue;
    const facts = event.facts as Record<string, unknown> | null;
    if (!facts) continue;
    const parsed = parseComponentsFromFacts(facts);
    if (parsed) return parsed;
  }
  return parseEvaluatorStateComponents(evaluatorState);
}

function behaviorSummary(alert: Alert): string {
  const mode = "Recurring";
  if (!alert.expiresAt) return mode;
  const formatted = formatExpiresAt(alert.expiresAt);
  return alert.expiresAt <= new Date() ? `${mode}, ${formatted}` : `${mode}, expires ${formatted}`;
}

function notifiersFor(
  notifiers: NotifierRef[],
  channels: Map<string, NotifierChannel>
): AlertDetailNotifier[] {
  return notifiers.map((notifier) => {
    if (notifier.type === "chat") {
      return { key: notifierRefKey(notifier), label: "This chat" };
    }
    const name = channels.get(notifier.channelId)?.name;
    return { key: notifierRefKey(notifier), label: name ?? "Deleted channel" };
  });
}

function behaviorLabel(alert: Alert): string {
  const mode = "Recurring";
  if (!alert.expiresAt) return mode;
  const formatted = formatExpiresAt(alert.expiresAt);
  return alert.expiresAt <= new Date()
    ? `${mode} · ${formatted}`
    : `${mode} · expires ${formatted}`;
}

export class AlertDetailPresenter extends BasePresenter {
  constructor(
    private readonly _alertDb: PrismaClientOrTransaction = prisma,
    prismaClient: PrismaClientOrTransaction = prisma,
    private readonly _resolveChannels: (
      params: Parameters<typeof loadNotifierChannels>[1]
    ) => ReturnType<typeof loadNotifierChannels> = (params) =>
      loadNotifierChannels(prismaClient, params),
    private readonly _resolveMemberName: (params: {
      userId: string;
      organizationId: string;
    }) => Promise<string | null> = async ({ userId, organizationId }) => {
      const member = await prismaClient.orgMember.findFirst({
        where: { userId, organizationId },
        select: { user: { select: { name: true, displayName: true, email: true } } },
      });
      return member?.user.displayName ?? member?.user.name ?? member?.user.email ?? null;
    },
    private readonly _resolveQueueFriendlyId: (params: {
      queue: string;
      environmentId: string;
    }) => Promise<string | null> = async ({ queue, environmentId }) => {
      const taskQueue = await prismaClient.taskQueue.findFirst({
        where: { runtimeEnvironmentId: environmentId, name: queue },
        select: { friendlyId: true },
      });
      return taskQueue?.friendlyId ?? null;
    },
    private readonly _getCurrentReadingDeps: GetCurrentReadingDeps = {
      evaluateBinding: createProductionEvaluateBinding({
        queryRowRunner: retryOnConcurrency(createQueryRowRunner(undefined, { lane: "alerts" })),
      }),
    }
  ) {
    super();
  }

  public async call(params: {
    id: string;
    projectId: string;
    environmentId: string;
    eventsWindow?: { since: Date; until: Date };
  }): Promise<AlertDetail | null> {
    return this.trace("call", async () => {
      const alert = await getAlert(this._alertDb, {
        id: params.id,
        projectId: params.projectId,
        environmentId: params.environmentId,
      });
      if (!alert) return null;

      const capability = getCapability(alert.capabilityKey);
      const condition = conditionSchema.parse(alert.condition);
      const alertParams = alertParamsSchema.parse(alert.params);

      const events = await listAlertEvents(this._alertDb, alert.id, { limit: 50 });
      const eventsWindow = params.eventsWindow;
      const windowEvents = eventsWindow
        ? (
            await listAlertEvents(this._alertDb, alert.id, {
              limit: 50,
              before: new Date(eventsWindow.until.getTime() + 1),
            })
          ).filter((event) => event.at >= eventsWindow.since)
        : events;
      const firstEventAt = await firstAlertEventAt(this._alertDb, alert.id);
      const eventTimes = (await getLatestAlertEventTimes(this._alertDb, [alert.id])).get(alert.id);
      const occurrenceCount =
        condition.kind === "occurrence"
          ? alert.occurrencesTotal
          : await countAlertEventsByType(this._alertDb, {
              alertId: alert.id,
              type: "raised",
            });
      const notifierRefs = alert.notifiers as NotifierRef[];
      const channelIds = notifierChannelIds(notifierRefs);
      const { environmentType, channels } =
        channelIds.length > 0
          ? await this._resolveChannels({
              projectId: alert.projectId,
              environmentId: alert.environmentId,
              channelIds,
            })
          : { environmentType: null, channels: new Map<string, NotifierChannel>() };
      const notifiers = notifiersFor(notifierRefs, channels);
      const channelIssues = alertChannelIssues(notifierRefs, channels, environmentType);
      const status = displayStatus(alert.lifecycle, alert.attention);

      let currentReading = await getCurrentReading(alert, this._getCurrentReadingDeps);

      const latestRaisedEvent = events.find((event) => event.type === "raised");
      const episode = episodeFromTimes(
        { raisedAt: eventTimes?.raised ?? null, recoveredAt: eventTimes?.recovered ?? null },
        { attention: alert.attention, observedCondition: alert.observedCondition }
      );

      if (currentReading.status === "unavailable" && latestRaisedEvent?.facts) {
        const facts = latestRaisedEvent.facts as Record<string, unknown>;
        if (typeof facts.value === "number" || Array.isArray(facts.offenders)) {
          currentReading = {
            status: "available",
            result: { kind: "stateful", outcome: "met", facts },
            observedAt: latestRaisedEvent.at,
          };
        }
      }
      const errorEvidence = condition.kind === "occurrence" ? errorEvidenceFor(events) : undefined;
      const occurrenceSummary =
        condition.kind === "occurrence" ? occurrenceSummaryFor(alert) : undefined;

      const isComposite = capability?.binding.compositeOf != null;
      const factsComponents = isComposite
        ? extractFactsComponents(currentReading, events, alert.evaluatorState)
        : null;
      const effectiveParams: AlertDetail["effectiveParams"] = [];
      if (capability?.binding.params) {
        const conditionParams =
          condition.kind === "state" && condition.params ? condition.params : {};
        for (const paramDef of capability.binding.params) {
          effectiveParams.push({
            key: paramDef.key,
            label: paramDef.label,
            value: conditionParams[paramDef.key] ?? paramDef.default,
            unit: paramDef.unit,
          });
        }
      }

      const [resolvedByLabel, stoppedByLabel, objectLink] = await Promise.all([
        alert.resolvedBy
          ? this._resolveMemberName({
              userId: alert.resolvedBy,
              organizationId: alert.organizationId,
            })
          : Promise.resolve(null),
        alert.stoppedBy
          ? this._resolveMemberName({
              userId: alert.stoppedBy,
              organizationId: alert.organizationId,
            })
          : Promise.resolve(null),
        this.objectLinkFor(alertParams.scope, alert.environmentId, condition, latestRaisedEvent),
      ]);

      return {
        id: alert.id,
        name: alert.name ?? capability?.title ?? alert.capabilityKey,
        capabilityKey: alert.capabilityKey,
        capabilityTitle: capability?.title ?? alert.capabilityKey,
        capabilityDescription: capability?.description,
        area: capability?.area ?? "unknown",
        environmentId: alert.environmentId,
        kind: condition.kind,
        operator: condition.kind === "threshold" ? condition.operator : undefined,
        thresholdValue: condition.kind === "threshold" ? condition.value : undefined,
        scope: alertParams.scope,
        scopeSummary: scopeSummary(
          alertParams.scope,
          capability?.area ?? "unknown",
          alert.capabilityKey,
          condition.kind === "state" ? condition.components : undefined
        ),
        conditionSummary: conditionSummary(condition, capability?.unit, capability?.title),
        compiledQuery:
          alert.query ??
          (capability?.binding.type === "query" && capability.binding.template
            ? compileTemplate(
                capability.binding.template,
                scopeWhere(alertParams),
                resolveEffectiveParams(
                  condition.kind === "state" ? condition : undefined,
                  capability.binding.params
                ),
                capability.binding.ctx?.includes("checkpoint")
                  ? { checkpoint: clickhouseDateTimeLiteral(checkpointOf(alert)), after: "1 = 1" }
                  : undefined
              )
            : undefined),
        windowSec: windowSecFor(condition, alertParams),
        behaviorSummary: behaviorSummary(alert),
        behaviorLabel: behaviorLabel(alert),
        status,
        channelIssues,
        evaluated: alert.lastEvaluatedAt != null,
        resolvedByLabel,
        stoppedByLabel,
        notifiers,
        events: windowEvents.map((event) => ({
          id: event.id,
          type: event.type,
          at: event.at,
          actorId: event.actorId,
          factsSummary: factsSummary(
            event.facts,
            capability?.unit,
            condition.kind,
            windowSecFor(condition, alertParams),
            condition.kind === "threshold" ? condition.value : undefined
          ),
          fingerprint:
            eventFingerprint(event.facts) ??
            (event.type === "raised" && alertParams.scope.type === "errorGroup"
              ? alertParams.scope.fingerprint
              : undefined),
          taskIdentifier:
            eventTaskIdentifier(event.facts) ??
            (event.type === "raised" && alertParams.scope.type === "errorGroup"
              ? alertParams.scope.taskIdentifier
              : undefined),
        })),
        latestRaisedEventFacts:
          errorEvidence && errorEvidence.length > 0
            ? { occurrences: errorEvidence }
            : latestRaisedEvent?.facts,
        occurrenceSummary,
        occurrenceCount,
        countSinceRaise: occurrenceSummary?.countSinceRaise,
        firstEventAt,
        lastEventAt: latestDate(events[0]?.at, alert.lastOccurrenceAt),
        unitSuffix: unitSuffix(capability?.unit),
        expiresAt: alert.expiresAt,
        reading: readingFor(
          currentReading,
          condition.kind,
          windowSecFor(condition, alertParams),
          latestRaisedEvent
        ),
        stateOutcome: stateOutcomeFor(currentReading, episode),
        episode,
        currentReading,
        objectLink,
        factsComponents,
        effectiveParams,
      };
    });
  }

  /**
   * A single concrete object: a queue/task named in the scope, or for occurrence-kind
   * alerts the fingerprint the most recent "raised" event fired for.
   */
  private async objectLinkFor(
    scope: AlertParams["scope"],
    environmentId: string,
    condition: Condition,
    latestRaisedEvent: AlertEvent | undefined
  ): Promise<AlertDetailObjectLink | undefined> {
    if (scope.type === "task") {
      return { kind: "task", taskIdentifier: scope.taskIdentifier, name: scope.taskIdentifier };
    }
    if (scope.type === "queue") {
      const friendlyId = await this._resolveQueueFriendlyId({ queue: scope.queue, environmentId });
      return friendlyId ? { kind: "queue", friendlyId, name: scope.queue } : undefined;
    }
    if (scope.type === "errorGroup") {
      return {
        kind: "fingerprint",
        fingerprint: scope.fingerprint,
        name: scopeDetail(scope, ""),
      };
    }
    if (condition.kind === "occurrence") {
      const fingerprint = eventFingerprint(latestRaisedEvent?.facts);
      if (fingerprint) {
        return {
          kind: "fingerprint",
          fingerprint,
          name: fingerprint.slice(0, 12),
        };
      }
    }
    return undefined;
  }
}

import type { AlertCreationDraft } from "@internal/dashboard-agent-contracts";
import type { AlertScopeType } from "@internal/alert-contracts";
import { z } from "zod";
import { MAX_WATCH_QUERY_LENGTH } from "~/components/alerts/queryAlertLink";
import type { QueryWatchPrefill } from "~/components/alerts/QueryAlertTranscript";
import { encodeErrorGroupScope, errorFingerprint } from "~/utils/errorGroupScope";
import {
  compositeComponents,
  needsScopeValue,
  resolveCapability,
  type FlowAnswers,
} from "./flow-state";

export const alertDraftPatchSchema = z
  .object({
    area: z.string().optional(),
    what: z.string().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    scope: z
      .object({
        type: z.string(),
        value: z.string().optional(),
        errorId: z.string().max(128).optional(),
        taskIdentifier: z.string().max(128).optional(),
        fingerprint: z.string().max(128).optional(),
      })
      .optional(),
    condition: z
      .object({
        kind: z.string().optional(),
        operator: z.enum([">", "<"]).optional(),
        value: z.number().optional(),
        unit: z.string().optional(),
        windowSec: z.number().optional(),
        params: z.record(z.string(), z.number()).optional(),
        compositeMode: z.enum(["any", "all"]).optional(),
        signals: z.array(z.enum(["approaching", "limited"])).optional(),
        components: z.array(z.string()).optional(),
      })
      .optional(),
    behavior: z
      .object({
        expiresAt: z.string().optional(),
        expiry: z.string().optional(),
      })
      .optional(),
    notifiers: z
      .array(
        z.object({
          type: z.string(),
          channelId: z.string().optional(),
          chatId: z.string().optional(),
        })
      )
      .optional(),
    query: z.string().max(MAX_WATCH_QUERY_LENGTH).optional(),
    querySignalChoice: z
      .object({
        mode: z.enum(["threshold", "absence", "match"]),
        measure: z.string().optional(),
      })
      .optional(),
    reason: z.string().optional(),
  })
  .strict()
  .refine((patch) => patch.condition?.operator !== "<" || patch.area === "query", {
    message: "Below-threshold alerts aren't supported yet",
  });

export type AlertDraftPatch = z.infer<typeof alertDraftPatchSchema>;

export function queryWatchFromPatch(patch: AlertDraftPatch): QueryWatchPrefill | undefined {
  if (patch.area !== "query" || !patch.query?.trim()) return undefined;
  return {
    query: patch.query,
    mode: patch.querySignalChoice?.mode,
    measure: patch.querySignalChoice?.measure,
    operator: patch.condition?.operator,
    value: patch.condition?.value,
    windowSec: patch.condition?.windowSec,
  };
}

/** The id to look up when an errorGroup patch didn't carry the task identifier. */
export function errorGroupToResolve(patch: AlertDraftPatch): string | undefined {
  const scope = patch.scope;
  if (scope?.type !== "errorGroup" || scope.taskIdentifier) return undefined;
  return scope.errorId ?? scope.fingerprint;
}

export function applyDraftPatch(answers: FlowAnswers, patch: AlertDraftPatch): FlowAnswers {
  const next = { ...answers };

  if (patch.area !== undefined) {
    next.area = patch.area as FlowAnswers["area"];
  }

  if (patch.what !== undefined) {
    if (patch.what !== answers.what) {
      const capability = resolveCapability(patch.what);
      const keepScope =
        capability !== undefined &&
        answers.scope !== undefined &&
        capability.allowedScopes.includes(answers.scope as AlertScopeType);
      if (!keepScope) {
        next.scope = undefined;
        next.scopeValue = undefined;
      }
      next.condition = undefined;
      next.windowMinutes = undefined;
      next.conditionParams = undefined;
      next.compositeMode = undefined;
      next.signals = undefined;
      next.components = undefined;
      next.picked = undefined;
    }
    next.what = patch.what;
    next.area = resolveCapability(patch.what)?.area ?? next.area;
  }

  if (patch.scope?.type === "errorGroup") {
    const fingerprint = patch.scope.fingerprint ?? errorFingerprint(patch.scope.errorId);
    if (fingerprint && patch.scope.taskIdentifier) {
      next.scope = "errorGroup";
      next.scopeValue = encodeErrorGroupScope({
        taskIdentifier: patch.scope.taskIdentifier,
        fingerprint,
      });
    }
  } else if (patch.scope !== undefined) {
    const { scope: prevScope, scopeValue: prevValue } = next;
    next.scope = patch.scope.type;
    next.scopeValue =
      patch.scope.value ??
      (patch.scope.type === prevScope && needsScopeValue(patch.scope.type) ? prevValue : undefined);
  }

  if (patch.condition !== undefined) {
    if (patch.condition.value !== undefined) {
      next.condition = String(patch.condition.value);
    }
    if (patch.condition.windowSec !== undefined) {
      next.windowMinutes = Math.ceil(patch.condition.windowSec / 60);
    }
    if (patch.condition.params !== undefined) {
      next.conditionParams = patch.condition.params;
    }
    if (patch.condition.compositeMode !== undefined) {
      next.compositeMode = patch.condition.compositeMode;
    }
    if (patch.condition.signals !== undefined) next.signals = patch.condition.signals;
    if (patch.condition.components !== undefined) {
      next.components = patch.condition.components;
      next.picked = undefined;
    }
  }

  if (patch.what !== undefined && next.what === "limits.all" && next.components === undefined) {
    next.components = compositeComponents("limits.all");
  }

  if (patch.name !== undefined) next.name = patch.name;

  if (patch.behavior !== undefined) {
    const expiry = patch.behavior.expiry ?? patch.behavior.expiresAt;
    if (expiry !== undefined) {
      const days = expiry.match(/^(\d+)d$/);
      next.expiry = days ? `${Number(days[1]) * 24}h` : expiry;
    }
  }

  if (patch.notifiers !== undefined) {
    next.notifiers = patch.notifiers.map((n) => {
      if (n.type === "chat" && n.chatId) return n.chatId;
      if (n.type === "channel" && n.channelId) return n.channelId;
      return n.type;
    });
  }

  return next;
}

function alertDraftContext(answers: FlowAnswers): AlertCreationDraft {
  const {
    area,
    what,
    scope,
    scopeValue,
    condition,
    conditionParams,
    compositeMode,
    signals,
    components,
    windowMinutes,
    notifiers,
    expiry,
    name,
  } = answers;
  return {
    capabilityKey: what,
    answers: {
      area,
      what,
      scope: scope as AlertCreationDraft["answers"]["scope"],
      scopeValue,
      condition,
      conditionParams,
      compositeMode,
      signals,
      components,
      windowMinutes,
      notifiers,
      expiry,
      name,
    },
  };
}

export function creationTurnClientData<T extends object>(clientData: T, answers: FlowAnswers) {
  return {
    ...clientData,
    toolScope: "alert_creation" as const,
    alertDraft: alertDraftContext(answers),
  };
}

/** An alert-creation chat keeps its tool scope when reopened outside creation mode. */
export function chatTurnClientData<T extends object>(
  clientData: T,
  chatKind: string | null | undefined
) {
  return chatKind === "alert_creation"
    ? { ...clientData, toolScope: "alert_creation" as const }
    : clientData;
}

/** A create deferred across a navigation keeps its creation scope on the new page's data. */
export function rescopeTurnClientData<T extends object>(
  current: T,
  deferred: { toolScope?: "alert_creation"; alertDraft?: AlertCreationDraft } | undefined
) {
  if (!deferred?.toolScope) return undefined;
  return { ...current, toolScope: deferred.toolScope, alertDraft: deferred.alertDraft };
}

export type CreationAgentChat = { seq: number; chatId?: string };

/** The chat a creation turn goes to, or undefined to start a new one for this session. */
export function creationChatToReuse(
  session: CreationAgentChat,
  entrySeq: number,
  activeChatId: string | undefined
): string | undefined {
  if (session.seq !== entrySeq || !session.chatId) return undefined;
  return session.chatId === activeChatId ? activeChatId : undefined;
}

export type ToolResultPayload = {
  ok: boolean;
  patch?: AlertDraftPatch;
  errors?: string[];
  reason?: string;
};

type ToolPart = { type?: string; state?: string; toolCallId?: string; output?: unknown };
type ToolMessage = { id: string; parts?: ReadonlyArray<unknown> };

export function pendingDraftPatches(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>
): ToolResultPayload[] {
  const results: ToolResultPayload[] = [];
  for (const message of messages) {
    for (let i = 0; i < (message.parts ?? []).length; i++) {
      const part = (message.parts ?? [])[i] as ToolPart;
      if (part?.type !== "tool-update_alert_draft" || part.state !== "output-available") continue;
      const key = part.toolCallId ?? `${message.id}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = part.output as ToolResultPayload | undefined;
      if (payload && typeof payload === "object") {
        results.push(payload);
      }
    }
  }
  return results;
}

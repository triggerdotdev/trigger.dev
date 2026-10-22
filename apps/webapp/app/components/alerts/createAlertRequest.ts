import { EXPIRY_TOKEN_PATTERN } from "~/components/alerts/alertCreatedCard";
import {
  alertName,
  defaultWindowMinutes,
  resolveCapability,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";

export const CREATE_ALERT_PATH = "/resources/alerts/create";

function expiryToIso(exp: string | undefined): string | undefined {
  if (!exp || exp === "none") return undefined;
  const EVENT_HOURS: Record<string, number> = { deploy: 168, incident: 720 };
  const hoursMatch = exp.match(/^(\d+)h$/);
  const hours = hoursMatch ? Number(hoursMatch[1]) : EVENT_HOURS[exp];
  if (hours) return new Date(Date.now() + hours * 3600_000).toISOString();
  return Number.isNaN(Date.parse(exp)) ? undefined : new Date(exp).toISOString();
}

export function replaceRequestBody(answers: FlowAnswers): FormData {
  const target = answers.replace!;
  const expiresAt = expiryToIso(answers.expiry);
  const body = new FormData();
  body.set("intent", "replace");
  body.set("channelId", target.channelId);
  body.set("alertType", target.alertType);
  body.set("environmentIds", (answers.environments ?? []).join(","));
  body.set("value", answers.condition ?? "0");
  if (answers.windowMinutes) body.set("windowMinutes", String(answers.windowMinutes));
  if (expiresAt) body.set("expiresAt", expiresAt);
  if (answers.scope) body.set("scopeType", answers.scope);
  if (answers.scopeValue) body.set("scopeValue", answers.scopeValue);
  body.set("notifierChannelIds", (answers.notifiers ?? []).filter((n) => n !== "chat").join(","));
  return body;
}

export function createAlertRequestBody(
  ids: { organizationId: string; projectId: string; environmentId: string },
  answers: FlowAnswers
) {
  const kind = resolveCapability(answers.what)?.allowedKinds[0] ?? "threshold";
  return {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    name: alertName(answers),
    expiry:
      answers.expiry && EXPIRY_TOKEN_PATTERN.test(answers.expiry) ? answers.expiry : undefined,
    form: {
      capabilityKey: answers.what,
      scopeType: answers.scope,
      scopeValue: answers.scopeValue,
      conditionKind: kind,
      operator: kind === "threshold" ? ">" : undefined,
      value: answers.condition ? Number(answers.condition) : undefined,
      windowMinutes:
        kind === "threshold"
          ? (answers.windowMinutes ?? defaultWindowMinutes(answers.what))
          : undefined,
      quietWindowMinutes:
        kind === "absence" && answers.condition ? Number(answers.condition) : undefined,
      conditionParams:
        kind === "state" && answers.conditionParams ? answers.conditionParams : undefined,
      expiresAt: expiryToIso(answers.expiry),
      notifierChannelIds: (answers.notifiers ?? []).filter((n) => n !== "chat"),
    },
  };
}

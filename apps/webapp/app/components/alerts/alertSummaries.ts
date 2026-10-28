import type { Condition } from "@internal/alert-contracts";
import { formatAlertValue } from "./formatAlertTick";
import { stateConditionSummary } from "./limitSummary";

export function humanizeSeconds(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function alertChartInfo(alert: {
  capabilityDescription?: string;
  conditionSummary: string;
}): string {
  return alert.capabilityDescription ?? alert.conditionSummary;
}

export function conditionSummary(condition: Condition, unit?: string, title?: string): string {
  switch (condition.kind) {
    case "threshold":
      return `${condition.operator} ${formatAlertValue(condition.value, unit)} over ${humanizeSeconds(
        condition.windowSec
      )}`;
    case "state":
      return stateConditionSummary(condition) ?? `State: ${condition.stateKey}`;
    case "occurrence":
      return title ?? "New occurrence";
    case "absence":
      return `No activity for ${humanizeSeconds(condition.quietWindowSec)}`;
  }
}

/**
 * Report-agnostic message infrastructure. Prose lives in each report's OWN catalog (e.g.
 * `health/health-messages.ts`); this file only defines the resolver surface + a registry so the
 * generic renderer can turn a VM's codes into strings by looking the catalog up via `vm.title`.
 * No report vocabulary here — that would re-couple the renderer to a specific report.
 */

import { REPORT_REGISTRY } from "./report-registry";
import { type ReasonCode, type Severity } from "./report-view-model";

/**
 * The resolver surface a report provides. Every renderer resolves a VM's codes through this;
 * strings may carry {tokens} (e.g. {age}, {rate}) that the renderer fills from evidence.
 */
export type ReportMessages = {
  metricLabel(id: string): string;
  findingReason(findingType: string, reason: ReasonCode, opts?: { expanded?: boolean }): string;
  readMessage(code: ReasonCode): string;
  exclusionMessage(code: ReasonCode): string;
  observationMessage(code: ReasonCode): string;
  annotationMessage(code: ReasonCode): string;
  statementMessage(findingType: string, severity: Severity, reason?: ReasonCode): string;
  actionMessage(code: ReasonCode): string;
};

/**
 * Look up a report's catalog by `vm.title`. Catalogs live as values on the
 * report registry entries — there is deliberately no register-at-import-time
 * step: a side-effect registration is exactly what the production bundle
 * tree-shakes away under `"sideEffects": false`.
 */
export function reportMessages(title: string): ReportMessages {
  const messages = REPORT_REGISTRY[title]?.messages;
  if (!messages) {
    throw new Error(`report-messages: no catalog registered for report "${title}"`);
  }
  return messages;
}

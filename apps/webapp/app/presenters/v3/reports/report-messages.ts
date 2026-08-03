/**
 * Report-agnostic message infrastructure. Prose lives in each report's OWN catalog (e.g.
 * `health/health-messages.ts`); this file only defines the resolver surface + a registry so the
 * generic renderer can turn a VM's codes into strings by looking the catalog up via `vm.title`.
 * No report vocabulary here — that would re-couple the renderer to a specific report.
 */

import { REPORT_MESSAGE_CATALOGS } from "./report-message-catalogs";
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

/** Look up a report's catalog by `vm.title`. Catalogs are values, never
 * registered at import time — side-effect registration is what the production
 * bundle tree-shakes away. */
export function reportMessages(title: string): ReportMessages {
  const messages = REPORT_MESSAGE_CATALOGS[title];
  if (!messages) {
    throw new Error(`report-messages: no catalog registered for report "${title}"`);
  }
  return messages;
}

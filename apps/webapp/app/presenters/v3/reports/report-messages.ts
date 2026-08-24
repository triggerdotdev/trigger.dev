import { REPORT_MESSAGE_CATALOGS } from "./report-message-catalogs";
import { type ReasonCode, type Severity } from "./report-view-model";

/** Strings may carry {tokens} the renderer fills from evidence. */
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

/** Catalogs are plain values, not import-time registrations: the bundle tree-shakes those away. */
export function reportMessages(title: string): ReportMessages {
  const messages = REPORT_MESSAGE_CATALOGS[title];
  if (!messages) {
    throw new Error(`report-messages: no catalog registered for report "${title}"`);
  }
  return messages;
}

/**
 * Catalogs by value, in a module that imports only the per-report `*-messages` files. Presentation
 * stays decoupled from the data layer, and a value import can't be tree-shaken away.
 */
import { healthMessages } from "./health/health-messages";
import { type ReportMessages } from "./report-messages";

export const REPORT_MESSAGE_CATALOGS: Record<string, ReportMessages> = {
  health: healthMessages,
};

import { healthMessages } from "./health/health-messages";
import { type ReportMessages } from "./report-messages";

export const REPORT_MESSAGE_CATALOGS: Record<string, ReportMessages> = {
  health: healthMessages,
};

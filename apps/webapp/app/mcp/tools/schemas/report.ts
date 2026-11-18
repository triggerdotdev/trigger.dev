import { ReportPeriodSchema } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const GetReportInput = CommonProjectsInput.pick({
  projectRef: true,
  configPath: true,
  environment: true,
  branch: true,
}).extend({
  key: z
    .enum(["health"])
    .describe(
      "The report to render. 'health' answers 'is work flowing, and is a problem my code or the platform?' with an interpreted verdict (flow / execution / liveness)."
    ),
  period: ReportPeriodSchema.optional().describe(
    "Time period shorthand for the live window, e.g. '1h' (default), '24h', '7d'. Minutes (m) to weeks (w), max 90d. Seconds are not supported — reports bucket by whole minutes."
  ),
  color: z
    .boolean()
    .optional()
    .describe(
      "Return the report as ANSI-coloured text instead of markdown. Only renders in hosts that display ANSI in tool output."
    ),
});

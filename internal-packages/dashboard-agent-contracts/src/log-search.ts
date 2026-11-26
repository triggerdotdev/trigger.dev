import { z } from "zod";

const levels = z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
const dateTime = z.string().datetime({ offset: true });
const dateFilter = z
  .string()
  .max(40)
  .refine((value) => dateTime.safeParse(value).success && Number.isFinite(Date.parse(value)), {
    message: "Invalid ISO 8601 time.",
  });
const cursor = z.string().max(16_384);

export const DASHBOARD_AGENT_LOG_SEARCH_LIMIT = 15;
export const DASHBOARD_AGENT_LOG_EXCERPT_CHARS = 500;
export const DASHBOARD_AGENT_LOG_ID_CHARS = 128;

export const dashboardAgentLogSearchValidationError = z.object({
  code: z.literal("log_search_validation"),
  error: z.string().max(512),
});

export const dashboardAgentLogSearchFilters = z.object({
  search: z
    .string()
    .max(1000)
    .optional()
    .describe("Match text in messages or attributes. At least 3 characters."),
  levels: z.array(levels).max(5).optional(),
  tasks: z
    .array(z.string().max(DASHBOARD_AGENT_LOG_ID_CHARS))
    .max(50)
    .optional()
    .describe("Task identifiers."),
  runId: z.string().max(DASHBOARD_AGENT_LOG_ID_CHARS).optional().describe("Filter to one run_ ID."),
  period: z
    .string()
    .regex(/^[1-9]\d{0,5}[mhdw]$/)
    .optional()
    .describe(
      "Relative time range, e.g. 30m, 1h, 1d or 1w. Defaults to 1d. Do not combine with from/to."
    ),
  from: dateFilter.optional().describe("ISO 8601 range start. Set both from and to."),
  to: dateFilter.optional().describe("ISO 8601 range end. Set both from and to."),
  cursor: cursor.optional().describe("Continue a previous search with the same filters."),
});

export const dashboardAgentLogSearchBody = dashboardAgentLogSearchFilters
  .refine(({ period, from, to }) => !period || (!from && !to), {
    message: "Pass either period or from/to, not both.",
  })
  .refine(({ from, to }) => (from === undefined) === (to === undefined), {
    message: "An absolute time range requires both from and to.",
  })
  .refine(({ from, to }) => !from || !to || Date.parse(from) <= Date.parse(to), {
    message: "from must be before or equal to to.",
  });

export const dashboardAgentLogSearchResult = z.object({
  logs: z
    .array(
      z.object({
        runId: z
          .string()
          .max(DASHBOARD_AGENT_LOG_ID_CHARS)
          .regex(/^run_[a-z0-9]+$/i)
          .optional(),
        taskIdentifier: z.string().max(DASHBOARD_AGENT_LOG_ID_CHARS),
        level: levels,
        timestamp: dateTime,
        message: z.string().max(DASHBOARD_AGENT_LOG_EXCERPT_CHARS + 1),
      })
    )
    .max(DASHBOARD_AGENT_LOG_SEARCH_LIMIT),
  range: z.object({ from: dateTime, to: dateTime }),
  searchedFrom: dateTime,
  searchedTo: dateTime.optional(),
  complete: z.boolean(),
  retentionClamped: z.boolean(),
  timedOut: z.boolean(),
  stopped: z.boolean(),
  expired: z.boolean(),
  cursorIgnored: z.boolean(),
  budgetSpent: z.boolean(),
  nextCursor: cursor.optional(),
});

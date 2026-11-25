import { z } from "zod";
import { CommonProjectsInput } from "./common";

const ERROR_ID = /^error_[A-Za-z0-9]{1,64}$/;
const CURSOR = /^[A-Za-z0-9+/_-]{1,4000}={0,2}$/;
const MAX_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const ErrorIdInput = z
  .string()
  .max(80)
  .regex(ERROR_ID, "must be an error id like error_abc123")
  .describe("The error group id, starts with error_. Use list_errors to find it.");

const TaskIdentifierInput = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "The task the error group belongs to. Needed only when the same error id occurs in more than one task."
  )
  .optional();

const Period = z
  .string()
  .max(20)
  .describe("Only count the last N time period, e.g. 1h, 1d, 7d. Overrides from/to when given.")
  .optional();

const Time = (what: string) =>
  z.string().max(40).describe(`Only count occurrences ${what} this ISO 8601 timestamp`).optional();

const Cursor = z.string().regex(CURSOR, "must be a cursor returned by a previous call");

export const ListErrorsInput = CommonProjectsInput.extend({
  status: z
    .array(z.enum(["unresolved", "resolved", "ignored"]))
    .max(3)
    .describe("Only return error groups with these statuses")
    .optional(),
  tasks: z
    .array(z.string().max(128))
    .max(50)
    .describe("Only return errors from these task identifiers. Up to 50, each up to 128 characters")
    .optional(),
  versions: z
    .array(z.string().max(128))
    .max(50)
    .describe("Only count occurrences in these task versions, e.g. 20250101.1")
    .optional(),
  search: z
    .string()
    .max(1000)
    .describe("Only return errors whose type or message contains this text")
    .optional(),
  period: Period,
  from: Time("after"),
  to: Time("before"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("The number of error groups per page. Up to 100, defaults to 25")
    .default(25),
  after: Cursor.describe(
    "The next cursor from a previous list_errors call with the same filters"
  ).optional(),
  before: Cursor.describe(
    "The previous cursor from a previous list_errors call with the same filters"
  ).optional(),
});

export type ListErrorsInput = z.output<typeof ListErrorsInput>;

export const GetErrorDetailsInput = CommonProjectsInput.extend({
  errorId: ErrorIdInput,
  taskIdentifier: TaskIdentifierInput,
  versions: z
    .array(z.string().max(128))
    .max(50)
    .describe("Only list runs from these task versions")
    .optional(),
  period: z
    .string()
    .max(20)
    .describe("Only list runs from the last N time period, e.g. 1h, 1d, 7d. Defaults to 7d")
    .optional(),
  runsLimit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .describe("How many recent runs with this error to list. Up to 25, defaults to 10")
    .default(10),
  runsCursor: Cursor.describe("The runs cursor from a previous get_error_details call").optional(),
});

export type GetErrorDetailsInput = z.output<typeof GetErrorDetailsInput>;

export const ErrorWriteInput = CommonProjectsInput.extend({
  errorId: ErrorIdInput,
  taskIdentifier: TaskIdentifierInput,
});

export const ResolveErrorInput = ErrorWriteInput.extend({
  resolvedInVersion: z
    .string()
    .min(1)
    .max(128)
    .describe("The version the fix ships in, recorded on the error group")
    .optional(),
});

export type ResolveErrorInput = z.output<typeof ResolveErrorInput>;

export const IgnoreErrorInput = ErrorWriteInput.extend({
  duration: z
    .number()
    .int()
    .positive()
    .max(MAX_DURATION_MS)
    .describe("Ignore for this many milliseconds, e.g. 3600000 for one hour")
    .optional(),
  occurrenceRate: z
    .number()
    .int()
    .positive()
    .max(1_000_000_000)
    .describe("Stop ignoring once it occurs more than this many times per minute")
    .optional(),
  totalOccurrences: z
    .number()
    .int()
    .positive()
    .max(1_000_000_000)
    .describe("Stop ignoring once it occurs this many more times")
    .optional(),
  reason: z.string().max(1000).describe("Why the error is ignored").optional(),
});

export type IgnoreErrorInput = z.output<typeof IgnoreErrorInput>;

export type ErrorWriteInput = z.output<typeof ErrorWriteInput>;

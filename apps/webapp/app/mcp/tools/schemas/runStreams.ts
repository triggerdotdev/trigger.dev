import { z } from "zod";
import { CommonRunsInput } from "./common";

export const ReadRunStreamInput = CommonRunsInput.extend({
  direction: z
    .enum(["output", "input"])
    .describe(
      "`output` for what the run streamed, `input` for what was sent to the run's input streams."
    )
    .default("output"),
  key: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "The stream key to read. Omit it with direction `output` to list the run's output stream keys."
    )
    .optional(),
  afterEventId: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Cursor: only return records after this event id. Use the cursor from a prior read.")
    .optional(),
  maxRecords: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe("Maximum records to return. Up to 200, defaults to 50.")
    .default(50),
  timeoutInSeconds: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe(
      "Wait up to this many seconds (at most 50) for a record when none exist yet. Omit for an immediate point-in-time read."
    )
    .optional(),
});

export type ReadRunStreamInput = z.output<typeof ReadRunStreamInput>;

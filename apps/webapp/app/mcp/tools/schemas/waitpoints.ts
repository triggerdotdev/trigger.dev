import { z } from "zod";
import { PREVIEW_LIMIT } from "../../confirm/confirmation.server";
import { PERIOD } from "./batches";
import { CommonProjectsInput } from "./common";

export const WAITPOINT_ID = /^waitpoint_[A-Za-z0-9]{1,64}$/;
export const WAITPOINT_LIST_CURSOR = /^[A-Za-z0-9._=-]{1,512}$/;

const waitpointId = (description: string) =>
  z
    .string()
    .regex(WAITPOINT_ID, "Must be lowercase waitpoint_ followed by letters and digits")
    .describe(description);

export const ListWaitpointTokensInput = CommonProjectsInput.extend({
  statuses: z
    .array(z.enum(["WAITING", "COMPLETED", "TIMED_OUT"]))
    .min(1)
    .max(3)
    .describe(
      "Only tokens with these statuses. Only the pair WAITING and TIMED_OUT without COMPLETED is refused; list those two one at a time. All three together list every token"
    )
    .optional(),
  tags: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(10)
    .describe("Only tokens with any of these tags. Up to 10, each up to 128 characters")
    .optional(),
  idempotencyKey: z
    .string()
    .min(1)
    .max(512)
    .describe("Only the token created with this idempotency key")
    .optional(),
  period: z
    .string()
    .regex(PERIOD, "Must be a duration like 1h, 7d or 30d")
    .describe("Only tokens created in the last N time period, e.g. 1h, 7d, 30d")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe("The number of tokens to list. Up to 100, defaults to 25")
    .default(25),
  cursor: z
    .string()
    .regex(WAITPOINT_LIST_CURSOR, "Must be a cursor returned by list_waitpoint_tokens")
    .describe("The cursor from a previous list_waitpoint_tokens call, to list older ones")
    .optional(),
});

export type ListWaitpointTokensInput = z.output<typeof ListWaitpointTokensInput>;

export const GetWaitpointTokenInput = CommonProjectsInput.extend({
  waitpointId: waitpointId("The ID of the waitpoint, starts with waitpoint_"),
});

export type GetWaitpointTokenInput = z.output<typeof GetWaitpointTokenInput>;

export const CompleteWaitpointTokenInput = CommonProjectsInput.extend({
  waitpointId: waitpointId("The ID of the waitpoint, starts with waitpoint_"),
  action: z
    .enum(["complete", "timeout", "skip"])
    .describe(
      "complete: complete a token with output. timeout: complete a token as timed out. skip: end a wait.for or wait.until now"
    ),
  output: z
    .string()
    .max(PREVIEW_LIMIT)
    .describe(
      "JSON text the waiting runs receive as the token's output. Only with action complete; defaults to {}"
    )
    .optional(),
});

export type CompleteWaitpointTokenInput = z.output<typeof CompleteWaitpointTokenInput>;

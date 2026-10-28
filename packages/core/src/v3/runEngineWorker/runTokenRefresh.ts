import { z } from "zod/v4";
import { discriminatedUnion } from "../utils/zod.js";

/**
 * Refresh-capable runners ask for a replacement once their installed run token has this long left.
 * It must stay well above the SDK's own expiry buffer so a refresh lands before the SDK falls back.
 */
export const RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS = 15 * 60;

export const RUN_TOKEN_REFRESH_TRIGGERS = ["heartbeat", "restore"] as const;
export type RunTokenRefreshTrigger = (typeof RUN_TOKEN_REFRESH_TRIGGERS)[number];

export const RUN_TOKEN_INSTALL_FAILURE_REASONS = [
  "ack_timeout",
  "ipc_error",
  "identity_mismatch",
  "no_child",
  "unsupported",
  "invalid_token",
  "other",
] as const;
export type RunTokenInstallFailureReason = (typeof RUN_TOKEN_INSTALL_FAILURE_REASONS)[number];

export type RunTokenInstallResult =
  | { result: "success" }
  | { result: "failure"; reason: RunTokenInstallFailureReason };

const RunTokenRefreshTriggerSchema = z.enum(RUN_TOKEN_REFRESH_TRIGGERS).catch("heartbeat");

const RunTokenInstallReport = discriminatedUnion("result", [
  z.object({ result: z.literal("success"), trigger: RunTokenRefreshTriggerSchema }),
  z.object({
    result: z.literal("failure"),
    reason: z.enum(RUN_TOKEN_INSTALL_FAILURE_REASONS).catch("other"),
    trigger: RunTokenRefreshTriggerSchema,
  }),
]);

/**
 * Sent by refresh-capable runners on run heartbeats. Runner-reported, so it only drives timing and
 * telemetry: the replacement's identity always comes from the server's own run state.
 */
export const RunTokenHeartbeatReport = z.object({
  /** `exp` (unix seconds) of the token currently installed in the task process. */
  expiresAt: z.number().int(),
  trigger: RunTokenRefreshTriggerSchema,
  /** Outcome of installing the previous replacement, reported once. */
  installation: RunTokenInstallReport.optional().catch(undefined),
});
export type RunTokenHeartbeatReport = z.infer<typeof RunTokenHeartbeatReport>;

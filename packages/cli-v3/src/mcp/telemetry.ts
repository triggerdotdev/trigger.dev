import { PostHog } from "posthog-node";
import { env } from "std-env";
import { POSTHOG_INGEST_HOST, POSTHOG_PROJECT_KEY } from "../consts.js";
import type { McpContextOptions } from "./context.js";

/**
 * Analytics for the MCP server, sent straight from the CLI.
 *
 * Off when the user says so, by `--skip-telemetry` or TRIGGER_TELEMETRY_DISABLED (the same
 * variable the webapp honours). Tools that report anywhere are hidden while it is off, rather
 * than left to fail at call time.
 */
export function isTelemetryEnabled(options: McpContextOptions): boolean {
  if (options.skipTelemetry) {
    return false;
  }

  return env.TRIGGER_TELEMETRY_DISABLED === undefined;
}

export type FeedbackEvent = {
  userId: string;
  message: string;
  toolName?: string;
  projectRef?: string;
  cliVersion: string;
};

/**
 * Captures a feedback report and waits for it to leave the machine. A stdio MCP server dies
 * whenever its client closes it, so an unflushed report would be lost while the agent had
 * already been told it was sent.
 */
export async function captureFeedback(event: FeedbackEvent): Promise<void> {
  // A client per report, shut down straight after. flush() resolves without delivering
  // anything - only shutdown() drains the queue - and reports are rare enough that the
  // extra client costs nothing next to reporting success for something never sent.
  const posthog = new PostHog(POSTHOG_PROJECT_KEY, { host: POSTHOG_INGEST_HOST });

  // shutdown() swallows fetch failures - it logs them and resolves - so without this the tool
  // would report a delivery that never happened. The error event is the only signal.
  let deliveryError: Error | undefined;
  posthog.on("error", (error: unknown) => {
    deliveryError ??= error instanceof Error ? error : new Error(String(error));
  });

  posthog.capture({
    distinctId: event.userId,
    event: "mcp_feedback_submitted",
    properties: {
      message: event.message,
      toolName: event.toolName,
      projectRef: event.projectRef,
      cliVersion: event.cliVersion,
      source: "mcp",
    },
    groups: event.projectRef ? { project: event.projectRef } : undefined,
  });

  await posthog.shutdown();

  if (deliveryError) {
    throw deliveryError;
  }
}

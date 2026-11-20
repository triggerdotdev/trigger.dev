import { WebhookInfrastructureError } from "@internal/webhook-engine";
import { tryCatch } from "@trigger.dev/core/utils";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { completeSessionStreamWaitpoints } from "~/services/realtime/sessionChannelAppend.server";
import {
  ensureRunForSession,
  reviveReusedRunIfEnded,
} from "~/services/realtime/sessionRunManager.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { ServiceValidationError } from "./services/common.server";

type DeliverySession = Parameters<typeof ensureRunForSession>[0]["session"];

/**
 * Deliver one webhook or channel record to a session's `.in`: make sure the session has a run,
 * append the record once per delivery, wake `.in` waiters, and re-check the run the record was
 * appended behind (`reviveReusedRunIfEnded`), since a run that ended meanwhile would never read it.
 *
 * `claimPart` / `commitPart` / `releasePart` keep a retried delivery from appending twice.
 */
export async function deliverPartToSession({
  environment,
  session,
  isCached,
  part,
  partId,
  claimPart,
  commitPart,
  releasePart,
}: {
  environment: AuthenticatedEnvironment;
  session: DeliverySession;
  isCached: boolean;
  part: string;
  partId: string;
  claimPart: () => Promise<"append" | "busy" | "done">;
  commitPart: () => Promise<void>;
  releasePart: () => Promise<void>;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const reason = isCached ? "continuation" : "initial";

  // Boot / revive the run, then append the record. The run reads it from `.in`.
  const ensured = await ensureRunForSession({ session, environment, reason });

  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });
  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return { ok: false, error: "Session channels require the S2 realtime backend" };
  }

  const addressingKey = session.externalId ?? session.friendlyId;

  const claim = await claimPart();
  if (claim === "busy") {
    throw new WebhookInfrastructureError(
      "Another attempt is appending this delivery to the session"
    );
  }
  let appendedSeq: number | undefined;
  if (claim === "append") {
    const [appendError, seq] = await tryCatch(
      realtimeStream.appendPartToSessionStream(part, partId, addressingKey, "in")
    );
    if (appendError) {
      // Nothing landed: release the claim so a retry re-appends the same id.
      await releasePart();
      // A ServiceValidationError (e.g. record too large) is terminal; anything else is transient.
      if (appendError instanceof ServiceValidationError) {
        return { ok: false, error: appendError.message };
      }
      throw appendError;
    }
    appendedSeq = seq;
    await commitPart();
  }

  // The record is durable now: look at the run it was appended behind again.
  const settled = await reviveReusedRunIfEnded({
    session,
    environment,
    reason,
    ensured,
    appendedSeq,
  });

  // Wake any `.in` waitpoints the run registered (best-effort; the record is durable in S2).
  await completeSessionStreamWaitpoints(environment, addressingKey, "in", part);

  return { ok: true, runId: settled.runId };
}

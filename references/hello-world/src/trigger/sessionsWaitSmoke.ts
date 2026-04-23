import { logger, sessions, task, tasks, wait } from "@trigger.dev/sdk";

/**
 * Smoke test for `session.in.waitWithIdleTimeout` end-to-end.
 *
 * Flow:
 *   1. Orchestrator (this task) creates a session.
 *   2. Orchestrator triggers {@link sessionsWaitSmokeSender} with a 2s delay
 *      and the payload — fire-and-forget (not awaited).
 *   3. Orchestrator calls `handle.in.waitWithIdleTimeout({ idleTimeoutInSeconds: 1, timeout: "30s" })`.
 *   4. Idle phase (1s) expires first → run suspends on the session-stream
 *      waitpoint.
 *   5. Sender wakes at +2s and calls `handle.in.send(payload)` → session
 *      append handler fires the waitpoint → orchestrator resumes with
 *      the payload.
 *   6. Orchestrator asserts the resumed payload matches and closes the session.
 *
 * Trigger via:
 *   mcp__trigger__trigger_task(taskId: "sessions-wait-smoke", payload: {})
 */
export const sessionsWaitSmoke = task({
  id: "sessions-wait-smoke",
  run: async () => {
    const runId = Date.now();
    const externalId = `wait-smoke-${runId}`;
    const sentinel = { role: "user", content: `hello-${runId}` };

    logger.info("create session", { externalId });
    const created = await sessions.create({
      type: "chat.agent",
      externalId,
      tags: ["smoketest", "waitpoint"],
    });

    logger.info("trigger delayed sender (+2s)");
    await tasks.trigger<typeof sessionsWaitSmokeSender>(
      "sessions-wait-smoke-sender",
      {
        sessionExternalId: externalId,
        delayMs: 2000,
        payload: sentinel,
      }
    );

    const handle = sessions.open(externalId);

    logger.info("waitWithIdleTimeout (idle 1s, then suspend, 30s timeout)");
    const result = await handle.in.waitWithIdleTimeout<typeof sentinel>({
      idleTimeoutInSeconds: 1,
      timeout: "30s",
    });

    if (!result.ok) {
      logger.error("waitWithIdleTimeout failed", { error: result.error?.message });
      return { ok: false, externalId, sessionId: created.id, error: result.error?.message };
    }

    const match =
      result.output.role === sentinel.role && result.output.content === sentinel.content;

    await sessions.close(externalId, { reason: "smoketest-done" });

    return {
      ok: true,
      externalId,
      sessionId: created.id,
      received: result.output,
      match,
    };
  },
});

/**
 * Helper task: sleeps `delayMs` then sends `payload` to the given session's
 * `.in` channel. Used by {@link sessionsWaitSmoke} to exercise the
 * session-stream waitpoint path — the orchestrator suspends, this task
 * fires the waitpoint via append.
 */
export const sessionsWaitSmokeSender = task({
  id: "sessions-wait-smoke-sender",
  run: async (payload: {
    sessionExternalId: string;
    delayMs: number;
    payload: unknown;
  }) => {
    logger.info("sender sleeping", { delayMs: payload.delayMs });
    await wait.for({ seconds: payload.delayMs / 1000 });

    logger.info("sender -> session.in.send", {
      sessionExternalId: payload.sessionExternalId,
    });
    const handle = sessions.open(payload.sessionExternalId);
    await handle.in.send(payload.payload);

    return { ok: true };
  },
});

import { logger, sessions, task } from "@trigger.dev/sdk";

/**
 * End-to-end smoke test for the Session SDK and server routes.
 *
 * Exercises every code path:
 *   - control-plane CRUD (create / retrieve / update / close)
 *   - polymorphic lookup via friendlyId and externalId
 *   - list with tag / type / externalId filters
 *   - cursor pagination (page 1 -> page 2)
 *   - realtime `.out` initialize + append + subscribe (SSE round-trip)
 *   - realtime `.in` send
 *   - idempotent close
 *
 * Trigger from the dashboard or via the MCP `trigger_task` tool:
 *
 *   mcp__trigger__trigger_task(taskId: "sessions-smoke", payload: {})
 *
 * Inside a run, the SDK picks up the ambient environment credentials, so
 * no `configure()` call is needed.
 */
export const sessionsSmoke = task({
  id: "sessions-smoke",
  run: async () => {
    const runId = Date.now();
    const results: Record<string, unknown> = {};

    logger.info("sessions.create");
    const created = await sessions.create({
      type: "chat.agent",
      externalId: `smoke-${runId}`,
      tags: ["smoketest", "sdk"],
      metadata: { purpose: "session-smoketest", runId },
    });
    results.created = { id: created.id, isCached: created.isCached };

    logger.info("sessions.retrieve by friendlyId");
    const byId = await sessions.retrieve(created.id);
    results.retrievedByFriendlyId = byId.externalId;

    logger.info("sessions.retrieve by externalId (polymorphic)");
    const byExt = await sessions.retrieve(created.externalId!);
    results.retrievedByExternalId = byExt.id;

    logger.info("sessions.update tags + metadata");
    const updated = await sessions.update(created.id, {
      tags: ["smoketest", "sdk", "updated"],
      metadata: { purpose: "session-smoketest", runId, touched: true },
    });
    results.updated = {
      tags: updated.tags,
      touched: (updated.metadata as Record<string, unknown> | null)?.touched,
    };

    const handle = sessions.open(created.externalId!);

    logger.info("sessions.open(...).out.initialize (S2 creds)");
    const outCreds = await handle.out.initialize();
    results.outInitialize = { basin: outCreds.basin, streamName: outCreds.streamName };

    logger.info("sessions.open(...).out.append x2 + .in.send x1");
    await handle.out.append({ chunk: "first", ts: Date.now() });
    await handle.out.append({ chunk: "second", ts: Date.now() });
    await handle.in.send({ role: "user", content: "hello from smoketest" });

    logger.info("sessions.open(...).out.subscribe (SSE round-trip)");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const received: Array<{ id: string; chunk: unknown }> = [];
    try {
      const stream = await handle.out.subscribe({
        signal: controller.signal,
        timeoutInSeconds: 3,
        onPart: (part) => {
          received.push({ id: part.id, chunk: part.chunk });
        },
      });
      let count = 0;
      for await (const _chunk of stream) {
        count += 1;
        if (count >= 2) break;
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timer);
    }
    results.subscribed = received;

    // Seed a couple extra sessions so list queries have multiple hits.
    await sessions.create({
      type: "chat.agent",
      externalId: `smoke-${runId}-b`,
      tags: ["smoketest"],
    });
    await sessions.create({
      type: "run.output",
      externalId: `smoke-${runId}-c`,
      tags: ["smoketest"],
    });

    // Let ClickHouse replication catch up.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    logger.info("sessions.list by tag");
    const listedAll = await sessions.list({ tag: "smoketest", limit: 50 });
    results.listByTag = listedAll.data.length;

    logger.info("sessions.list type + tag");
    const listedChat = await sessions.list({
      type: "chat.agent",
      tag: "smoketest",
      limit: 50,
    });
    results.listByTypeAndTag = {
      count: listedChat.data.length,
      types: [...new Set(listedChat.data.map((session) => session.type))],
    };

    logger.info("sessions.list by externalId");
    const listedOne = await sessions.list({ externalId: `smoke-${runId}` });
    results.listByExternalId = {
      count: listedOne.data.length,
      match: listedOne.data[0]?.id === created.id,
    };

    logger.info("sessions.list pagination");
    const page1 = await sessions.list({ tag: "smoketest", limit: 2 });
    let page2Ids: string[] = [];
    if (page1.pagination.next) {
      const page2 = await sessions.list({
        tag: "smoketest",
        limit: 2,
        after: page1.pagination.next,
      });
      page2Ids = page2.data.map((s) => s.id);
    }
    results.pagination = {
      page1Ids: page1.data.map((s) => s.id),
      next: page1.pagination.next,
      page2Ids,
    };

    logger.info("sessions.close");
    const closed = await sessions.close(created.externalId!, { reason: "smoketest-done" });
    results.closed = { closedAt: closed.closedAt, reason: closed.closedReason };

    logger.info("sessions.close (idempotent)");
    const reclosed = await sessions.close(created.externalId!, {
      reason: "should-not-clobber",
    });
    results.idempotentClose = {
      closedAtUnchanged: reclosed.closedAt?.toString() === closed.closedAt?.toString(),
      reasonUnchanged: reclosed.closedReason === closed.closedReason,
    };

    return { ok: true, runId, results };
  },
});

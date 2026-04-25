import { task, sessions, logger } from "@trigger.dev/sdk";

const SMOKE_TYPE = "smoke.sessions";

export const sessionsT21Idempotency = task({
  id: "sessions-t21-idempotency",
  run: async () => {
    const externalId = `smoke-idem-${Date.now()}`;
    const a = await sessions.create({ type: SMOKE_TYPE, externalId });
    const b = await sessions.create({ type: SMOKE_TYPE, externalId });
    return { a: a.id, b: b.id, idempotent: a.id === b.id };
  },
});

export const sessionsT22ListByType = task({
  id: "sessions-t22-list-by-type",
  run: async () => {
    const externalId = `smoke-list-${Date.now()}`;
    const created = await sessions.create({ type: SMOKE_TYPE, externalId });
    const page = await sessions.list({ type: SMOKE_TYPE, limit: 50 });
    const found = page.data.find((s) => s.id === created.id);
    return { createdId: created.id, count: page.data.length, found: !!found };
  },
});

export const sessionsT23ListByTag = task({
  id: "sessions-t23-list-by-tag",
  run: async () => {
    const tag = `smoke-tag-${Date.now()}`;
    const created = await sessions.create({ type: SMOKE_TYPE, tags: [tag] });
    const page = await sessions.list({ tag, limit: 50 });
    const found = page.data.find((s) => s.id === created.id);
    return { tag, createdId: created.id, count: page.data.length, found: !!found };
  },
});

export const sessionsT24CrossRunOpen = task({
  id: "sessions-t24-cross-run-open",
  run: async () => {
    const externalId = `smoke-cross-${Date.now()}`;
    const created = await sessions.create({ type: SMOKE_TYPE, externalId });
    // Reopen via friendlyId — no network call (open is lazy)
    const handleByFriendly = sessions.open(created.id);
    // Reopen via externalId
    const handleByExternal = sessions.open(externalId);
    // Append a record from each handle to verify both write to the same stream
    await handleByFriendly.out.append({ type: "smoke", from: "friendly", t: Date.now() });
    await handleByExternal.out.append({ type: "smoke", from: "external", t: Date.now() });
    return {
      sessionId: created.id,
      handleFriendlyId: handleByFriendly.id,
      handleExternalId: handleByExternal.id,
    };
  },
});

export const sessionsT26CloseAndReopen = task({
  id: "sessions-t26-close-and-reopen",
  run: async () => {
    const externalId = `smoke-close-${Date.now()}`;
    const created = await sessions.create({ type: SMOKE_TYPE, externalId });
    await sessions.close(created.id, { reason: "smoke close" });
    const after = await sessions.retrieve(created.id);
    // Recreate by externalId — should be idempotent (return same id) or a fresh one
    const recreated = await sessions.create({ type: SMOKE_TYPE, externalId });
    return {
      created: created.id,
      closedStatus: (after as { status?: string }).status,
      recreated: recreated.id,
      sameId: created.id === recreated.id,
    };
  },
});

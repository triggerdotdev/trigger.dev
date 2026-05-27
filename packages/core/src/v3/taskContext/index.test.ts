import { afterEach, describe, expect, it } from "vitest";
import { unregisterGlobal } from "../utils/globals.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";
import { TaskContextAPI } from "./index.js";

const FAKE_CTX = {
  attempt: { id: "attempt_1", number: 1, startedAt: new Date(), status: "EXECUTING" as const },
  run: {
    id: "run_1",
    payload: undefined,
    payloadType: "application/json",
    context: undefined,
    createdAt: new Date(),
    tags: [],
    isTest: false,
    isReplay: false,
    startedAt: new Date(),
    durationMs: 0,
    costInCents: 0,
    baseCostInCents: 0,
  },
  task: { id: "my-task", filePath: "src/trigger/task.ts", exportName: "myTask" },
  queue: { id: "queue_1", name: "default" },
  environment: { id: "env_1", slug: "dev", type: "DEVELOPMENT" as const },
  organization: { id: "org_1", slug: "acme", name: "Acme" },
  project: { id: "proj_1", ref: "proj_xyz", slug: "demo", name: "Demo" },
  machine: {
    name: "small-1x" as const,
    cpu: 0.5,
    memory: 0.5,
    centsPerMs: 0.0001,
  },
} as never;

const FAKE_WORKER = { id: "worker_1", version: "1.0.0", contentHash: "abc" } as never;

describe("TaskContextAPI conversation id", () => {
  afterEach(() => {
    unregisterGlobal("task-context");
    TaskContextAPI.getInstance().setConversationId(undefined);
  });

  it("returns no conversation attribute when setConversationId was never called", () => {
    const api = TaskContextAPI.getInstance();
    api.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });

    expect(api.attributes[SemanticInternalAttributes.GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });

  it("includes gen_ai.conversation.id after setConversationId", () => {
    const api = TaskContextAPI.getInstance();
    api.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });

    api.setConversationId("chat_123");

    expect(api.attributes[SemanticInternalAttributes.GEN_AI_CONVERSATION_ID]).toBe("chat_123");
  });

  it("clears the conversation attribute when called with undefined", () => {
    const api = TaskContextAPI.getInstance();
    api.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });
    api.setConversationId("chat_123");

    api.setConversationId(undefined);

    expect(api.attributes[SemanticInternalAttributes.GEN_AI_CONVERSATION_ID]).toBeUndefined();
    expect(api.conversationId).toBeUndefined();
  });

  it("returns no attributes when there is no task context", () => {
    const api = TaskContextAPI.getInstance();
    api.setConversationId("chat_123");

    expect(api.attributes).toEqual({});
  });

  it("clears conversation id when a new task context is registered (warm restart)", () => {
    const api = TaskContextAPI.getInstance();
    api.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });
    api.setConversationId("chat_old");

    api.setGlobalTaskContext({ ctx: FAKE_CTX, worker: FAKE_WORKER });

    expect(api.attributes[SemanticInternalAttributes.GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });
});

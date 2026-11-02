import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { runFields, vConfig, vTriggerOptions } from "./shared.js";

export default defineSchema({
  runs: defineTable({
    ...runFields,
    generation: v.number(),
    checks: v.number(),
    failures: v.number(),
    checking: v.optional(v.boolean()),
    refreshRequested: v.optional(v.boolean()),
    lastCheckAt: v.optional(v.number()),
    callback: v.optional(v.string()),
  }).index("by_key", ["idempotencyKey"]),
  requests: defineTable({
    run: v.id("runs"),
    payload: v.optional(v.any()),
    options: vTriggerOptions,
    config: vConfig,
  }).index("by_run", ["run"]),
});

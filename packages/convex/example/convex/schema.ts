import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import type { SampleId } from "../shared/types";

export const vSample = v.union(
  ...[
    "forest",
    "coast",
    "mountains",
    "city",
    "desert",
    "lake",
    "dog",
    "flowers",
    "architecture",
    "canyon",
  ].map((value) => v.literal(value as SampleId))
);
export const vPreset = v.union(v.literal("balanced"), v.literal("compact"), v.literal("quality"));

export const vSlot = v.union(
  v.literal("prepared"),
  v.literal("edited"),
  v.literal("hero"),
  v.literal("card"),
  v.literal("square")
);
export default defineSchema({
  edits: defineTable({
    ownerHash: v.string(),
    workerHash: v.string(),
    realtimeEligible: v.optional(v.boolean()),
    realtimeToken: v.optional(
      v.object({ accessToken: v.string(), expiresAt: v.number(), runId: v.string() })
    ),
    sample: vSample,
    preset: vPreset,
    prompt: v.string(),
    requestId: v.string(),
    key: v.string(),
    componentRunId: v.optional(v.string()),
    expiresAt: v.number(),
    finalStatus: v.optional(v.string()),
    deliveryError: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    inputBytes: v.optional(v.number()),
    processingMs: v.optional(v.number()),
    files: v.array(v.object({ slot: vSlot, storageId: v.id("_storage") })),
    variants: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("hero"), v.literal("card"), v.literal("square")),
          width: v.number(),
          height: v.number(),
          bytes: v.number(),
          format: v.literal("avif"),
        })
      )
    ),
  })
    .index("by_owner", ["ownerHash", "expiresAt"])
    .index("by_request", ["ownerHash", "requestId"])
    .index("by_key", ["ownerHash", "key"])
    .index("by_run", ["componentRunId"]),

  jobs: defineTable({
    sample: vSample,
    preset: vPreset,
    key: v.string(),
    requestId: v.string(),
    componentRunId: v.string(),
    finalStatus: v.optional(v.string()),
    deliveryError: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    inputBytes: v.optional(v.number()),
    processingMs: v.optional(v.number()),
    variants: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("hero"), v.literal("card"), v.literal("square")),
          width: v.number(),
          height: v.number(),
          bytes: v.number(),
          format: v.literal("avif"),
          storageId: v.id("_storage"),
        })
      )
    ),
  })
    .index("by_key", ["key"])
    .index("by_request", ["requestId"])
    .index("by_run", ["componentRunId"]),
  launchControl: defineTable({
    used: v.number(),
    modelUsed: v.optional(v.number()),
    dayStart: v.optional(v.number()),
    dayUsed: v.optional(v.number()),
    activeEdit: v.optional(v.id("edits")),
    lastLaunchAt: v.number(),
    activeJob: v.optional(v.id("jobs")),
  }),
});

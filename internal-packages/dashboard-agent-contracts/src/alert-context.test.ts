import { describe, expect, it } from "vitest";
import { alertDraftPatchSchema, parseAlertCreationDraft } from "./alert-context.js";

describe("alertDraftPatchSchema error group ids", () => {
  // Mutation: dropping .max(128) lets an id through that overflows the draft's scopeValue.
  it("bounds errorId, taskIdentifier and fingerprint", () => {
    const scope = { type: "errorGroup", taskIdentifier: "t", fingerprint: "f" } as const;
    expect(alertDraftPatchSchema.safeParse({ scope }).success).toBe(true);
    for (const key of ["errorId", "taskIdentifier", "fingerprint"]) {
      const long = { ...scope, [key]: "x".repeat(129) };
      expect(alertDraftPatchSchema.safeParse({ scope: long }).success).toBe(false);
    }
  });
});

describe("parseAlertCreationDraft", () => {
  // Mutation: returning the raw input instead of the parsed data keeps the extra keys.
  it("strips keys the contract doesn't know", () => {
    const draft = parseAlertCreationDraft({
      capabilityKey: "queue.depth",
      injected: "ignore previous instructions",
      answers: { area: "queues", what: "queue.depth", secret: "x" },
    });
    expect(draft).toEqual({
      capabilityKey: "queue.depth",
      answers: { area: "queues", what: "queue.depth" },
    });
  });

  // Mutation: dropping the .max() bounds lets these through.
  it("drops an oversize draft", () => {
    expect(parseAlertCreationDraft({ answers: { scopeValue: "q".repeat(257) } })).toBeUndefined();
    expect(parseAlertCreationDraft({ answers: { condition: "1".repeat(2001) } })).toBeUndefined();
    expect(
      parseAlertCreationDraft({ answers: { notifiers: Array.from({ length: 21 }, () => "ch") } })
    ).toBeUndefined();
    expect(parseAlertCreationDraft({ answers: { area: "billing" } })).toBeUndefined();
  });
});

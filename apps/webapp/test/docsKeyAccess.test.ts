import { describe, expect, it } from "vitest";
import { docsKeyAccess } from "~/services/docsKeys.server";

const triggerScopes = ["trigger:tasks", "batchTrigger:tasks"];
const options = {
  presets: [],
  catalogue: {
    available: true,
    capabilities: [
      {
        id: "tasks",
        label: "Tasks",
        levels: [
          { id: "none", label: "None", scopes: [] },
          { id: "read", label: "Read", scopes: ["read:tasks"] },
          { id: "trigger", label: "Trigger", scopes: triggerScopes },
          { id: "readTrigger", label: "Read & trigger", scopes: ["read:tasks", ...triggerScopes] },
        ],
      },
      {
        id: "sessions",
        label: "Sessions",
        levels: [
          { id: "none", label: "None", scopes: [] },
          {
            id: "readWrite",
            label: "Read & write",
            scopes: ["read:sessions", "write:sessions"],
            requires: [{ capabilityId: "tasks", levelIds: ["trigger", "readTrigger"], note: "" }],
          },
        ],
      },
    ],
  },
} as unknown as Parameters<typeof docsKeyAccess>[1];

describe("docsKeyAccess", () => {
  // Catches: a level another capability requires replacing one already chosen, so the key lacks
  // read:tasks while the docs are told it has it (and the result depending on the order asked).
  it("keeps every requested scope when a requirement raises a capability, in either order", () => {
    for (const needed of [
      ["read:tasks", "write:sessions"],
      ["write:sessions", "read:tasks"],
    ]) {
      const access = docsKeyAccess(needed, options);
      expect(access.capabilities).toEqual({ tasks: "readTrigger", sessions: "readWrite" });
      expect(access.scopes?.sort()).toEqual(
        ["read:tasks", ...triggerScopes, "read:sessions", "write:sessions"].sort()
      );
    }
  });

  // Catches: the docs creating a full-access key when nothing narrower covers the operation.
  it("returns null rather than full access", () => {
    const fullOnly = {
      ...options,
      presets: [
        { id: "FULL_ACCESS", available: true, usesTaskSelection: false, scopes: ["admin"] },
      ],
    } as unknown as Parameters<typeof docsKeyAccess>[1];
    expect(docsKeyAccess(["read:schedules"], fullOnly)).toBeNull();
    expect(docsKeyAccess(null, fullOnly)).toBeNull();
    expect(docsKeyAccess(["read:tasks"], null)).toBeNull();
  });
});

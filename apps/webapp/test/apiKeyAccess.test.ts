import type {
  ApiKeyCapability,
  ApiKeyCapabilityCatalogue,
  ApiKeyCapabilityMap,
} from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyAccessPreset,
  chosenPreset,
  customCapabilitiesAfterChange,
  customKeyUsesSelectedTasks,
  driftLine,
  driftSummary,
  grantsTaskAccess,
  OTHER_SCOPES_ONLY_LABEL,
  initialApiKeyAccess,
  requirementReason,
  resolvePresetSelection,
  scopesLostOnSave,
  summarizeCapabilities,
  taskAccessAfterPreset,
  taskSelectionChange,
} from "~/utils/apiKeyAccess";

const none = { id: "none", label: "None", scopes: [] };

const capabilities: ApiKeyCapability[] = [
  {
    id: "tasks",
    label: "Tasks",
    taskSelection: { kind: "scoped" },
    levels: [
      none,
      { id: "read", label: "Read", scopes: ["read:tasks"] },
      { id: "trigger", label: "Trigger", scopes: ["trigger:tasks"] },
      { id: "readTrigger", label: "Read and trigger", scopes: ["read:tasks", "trigger:tasks"] },
    ],
  },
  {
    id: "runs",
    label: "Runs",
    levels: [
      none,
      { id: "read", label: "Read", scopes: ["read:runs"] },
      { id: "readWrite", label: "Read and write", scopes: ["read:runs", "write:runs"] },
    ],
  },
  {
    id: "deployments",
    label: "Deployments",
    levels: [
      none,
      { id: "read", label: "Read", scopes: ["read:deployments"] },
      {
        id: "readWrite",
        label: "Read and write",
        scopes: ["read:deployments", "write:deployments"],
      },
    ],
  },
];

const catalogue: ApiKeyCapabilityCatalogue = { available: true, capabilities };

function preset(
  id: string,
  label: string,
  map: ApiKeyCapabilityMap,
  source?: "organization"
): ApiKeyAccessPreset {
  return {
    id,
    label,
    description: "",
    fullAccess: false,
    usesTaskSelection: false,
    available: true,
    capabilities: map,
    ...(source ? { source } : {}),
  };
}

const presets: ApiKeyAccessPreset[] = [
  preset("TRIGGER_ONLY", "Trigger only", { tasks: "trigger" }),
  preset("OBSERVER", "Observer", { tasks: "read", runs: "read" }),
  preset("DEPLOY_ONLY", "Deploy only", { deployments: "readWrite" }),
  preset("apikeypreset_1", "Saved runs", { runs: "readWrite" }, "organization"),
];

describe("summarizeCapabilities", () => {
  it("names a built-in preset the map matches exactly", () => {
    expect(summarizeCapabilities(catalogue, { deployments: "readWrite" }, presets)).toEqual({
      match: "Deploy only",
      text: "Deploy only",
    });
  });

  it("names a pair of built-in presets in preset order", () => {
    expect(
      summarizeCapabilities(catalogue, { deployments: "readWrite", tasks: "trigger" }, presets)
    ).toEqual({ text: "Trigger only + Deploy only" });
  });

  it("never names an organization preset", () => {
    expect(summarizeCapabilities(catalogue, { runs: "readWrite" }, presets)).toEqual({
      listsRows: true,
      text: "Runs: read and write",
    });
  });

  it("lists the granted rows when no preset or pair matches", () => {
    expect(
      summarizeCapabilities(catalogue, { runs: "readWrite", deployments: "read" }, presets)
    ).toEqual({ listsRows: true, text: "Runs: read and write, Deployments: read" });
  });

  it("adds the selected tasks to presets with a task row", () => {
    expect(
      summarizeCapabilities(catalogue, { tasks: "trigger", deployments: "readWrite" }, presets, [
        "report",
      ])
    ).toEqual({ text: "Trigger only (report) + Deploy only" });
    expect(
      summarizeCapabilities(catalogue, { tasks: "readTrigger" }, presets, ["a", "b", "c"])
    ).toEqual({ listsRows: true, text: "Tasks (a, b +1): read and trigger" });
  });

  it("says when nothing is granted", () => {
    expect(summarizeCapabilities(catalogue, { tasks: "none" }, presets)).toEqual({
      text: "No access",
    });
  });

  // Catches: a key whose only scopes are ones no level covers being labelled "No access".
  it("never says No access when the key holds scopes outside the levels", () => {
    expect(summarizeCapabilities(catalogue, {}, presets, undefined, ["read:waitpoints"])).toEqual({
      text: OTHER_SCOPES_ONLY_LABEL,
    });
  });

  // Catches: a custom key built on a preset giving no summary, so the reader adds up the rows.
  it("names the largest preset the key contains and what it adds", () => {
    expect(
      summarizeCapabilities(
        catalogue,
        { tasks: "read", runs: "read", deployments: "read" },
        presets
      ).basedOn
    ).toBe("Observer, plus Deployments: Read");
    expect(
      summarizeCapabilities(catalogue, { tasks: "read", runs: "readWrite" }, presets).basedOn
    ).toBe("Observer, plus Runs: Read and write");
    expect(
      summarizeCapabilities(catalogue, { runs: "readWrite" }, presets).basedOn
    ).toBeUndefined();
  });
});

describe("driftSummary", () => {
  // Catches: a raised level described as a newly granted area.
  it("tells new areas apart from raised levels", () => {
    expect(
      driftSummary(catalogue, "Observer", [
        { capabilityId: "deployments", from: "none", to: "read", gains: true, loses: false },
        { capabilityId: "runs", from: "read", to: "readWrite", gains: true, loses: false },
      ])
    ).toBe("Observer now adds Deployments, and raises Runs to Read and write.");
  });
});

describe("driftLine", () => {
  it("says what the preset grants today", () => {
    expect(driftLine(catalogue, { capabilityId: "runs", from: "read", to: "readWrite" })).toBe(
      "Runs: Read, preset now grants Read and write"
    );
  });
});

describe("taskSelectionChange", () => {
  const grants = (tasks: string[]) => ({ grantsTasks: true, tasks });
  const noTasks = { grantsTasks: false, tasks: [] };

  it("is empty when the tasks are the same in any order", () => {
    expect(taskSelectionChange(grants(["a", "b"]), grants(["b", "a"]))).toBeUndefined();
  });

  it("describes narrowing and widening", () => {
    expect(taskSelectionChange(grants([]), grants(["report"]))).toBe(
      "Tasks: limited to report (was all tasks)"
    );
    expect(taskSelectionChange(grants(["report"]), grants([]))).toBe(
      "Tasks: all tasks (was report)"
    );
  });

  it("says the key had no task access when its Tasks row was None", () => {
    expect(taskSelectionChange(noTasks, grants(["smoke-test"]))).toBe(
      "Tasks: limited to smoke-test (was no task access)"
    );
  });

  it("leaves gaining all tasks or losing task access to the level rows", () => {
    expect(taskSelectionChange(noTasks, grants([]))).toBeUndefined();
    expect(taskSelectionChange(grants(["report"]), noTasks)).toBeUndefined();
    expect(taskSelectionChange(noTasks, noTasks)).toBeUndefined();
  });
});

describe("grantsTaskAccess", () => {
  it("is true for full access or a granted task row", () => {
    expect(grantsTaskAccess(catalogue, {}, true)).toBe(true);
    expect(grantsTaskAccess(catalogue, { tasks: "trigger" }, false)).toBe(true);
    expect(grantsTaskAccess(catalogue, { runs: "read" }, false)).toBe(false);
  });
});

describe("taskAccessAfterPreset", () => {
  const allTasks = { taskScope: "all" as const, selectedTasks: ["report"] };
  const picked = { taskScope: "selected" as const, selectedTasks: ["report"] };

  it("selects Selected tasks with nothing picked for a preset that limits tasks", () => {
    expect(taskAccessAfterPreset({ limitsTasks: true }, allTasks, "replace")).toEqual({
      taskScope: "selected",
      selectedTasks: [],
    });
    expect(taskAccessAfterPreset({ limitsTasks: true }, picked, "replace")).toEqual({
      taskScope: "selected",
      selectedTasks: [],
    });
    expect(taskAccessAfterPreset({ limitsTasks: true }, allTasks, "add")).toEqual({
      taskScope: "selected",
      selectedTasks: [],
    });
  });

  it("keeps tasks already picked when adding a preset that limits tasks", () => {
    expect(taskAccessAfterPreset({ limitsTasks: true }, picked, "add")).toEqual(picked);
  });

  it("leaves task access alone for presets that don't limit tasks", () => {
    expect(taskAccessAfterPreset({}, allTasks, "replace")).toEqual(allTasks);
    expect(taskAccessAfterPreset({ limitsTasks: false }, picked, "add")).toEqual(picked);
  });
});

describe("customKeyUsesSelectedTasks", () => {
  it("needs selected scope and a granted task row", () => {
    expect(customKeyUsesSelectedTasks(catalogue, { tasks: "trigger" }, "selected")).toBe(true);
    expect(customKeyUsesSelectedTasks(catalogue, { tasks: "trigger" }, "all")).toBe(false);
    expect(customKeyUsesSelectedTasks(catalogue, { runs: "read" }, "selected")).toBe(false);
  });
});

describe("customCapabilitiesAfterChange", () => {
  const sessionsCatalogue: ApiKeyCapabilityCatalogue = {
    available: true,
    capabilities: [
      capabilities[0],
      {
        id: "sessions",
        label: "Sessions",
        taskSelection: { kind: "unavailable", reason: "Sessions need all tasks." },
        levels: [
          none,
          {
            id: "read",
            label: "Read",
            scopes: ["read:sessions"],
            requires: [{ capabilityId: "tasks", levelIds: ["trigger"], note: "" }],
          },
        ],
      },
    ],
  };

  it("drops a row that requirements make unavailable with selected tasks", () => {
    expect(
      customCapabilitiesAfterChange(sessionsCatalogue, { sessions: "read" }, "selected")
    ).toEqual({ tasks: "trigger" });
  });

  it("keeps the row with all tasks", () => {
    expect(customCapabilitiesAfterChange(sessionsCatalogue, { sessions: "read" }, "all")).toEqual({
      sessions: "read",
      tasks: "trigger",
    });
  });
});

describe("scopesLostOnSave", () => {
  it("keeps an unmatched scope that the next level grants again", () => {
    expect(scopesLostOnSave(catalogue, ["write:runs"], { runs: "readWrite" }, [])).toEqual([]);
  });

  it("lists unmatched scopes the next access doesn't grant", () => {
    expect(scopesLostOnSave(catalogue, ["write:runs", "read:query"], { runs: "read" }, [])).toEqual(
      ["write:runs", "read:query"]
    );
  });

  it("keeps a task-limited scope when the next access covers all tasks", () => {
    expect(scopesLostOnSave(catalogue, ["trigger:tasks:report"], { tasks: "trigger" }, [])).toEqual(
      []
    );
  });

  it("lists a task-limited scope when the next access selects other tasks", () => {
    expect(
      scopesLostOnSave(catalogue, ["trigger:tasks:report"], { tasks: "trigger" }, ["invoice"])
    ).toEqual(["trigger:tasks:report"]);
  });
});

describe("initialApiKeyAccess", () => {
  const stored = {
    presetId: "OBSERVER",
    fullAccess: false,
    capabilities: { tasks: "read", runs: "read", deployments: "read" },
  };

  it("opens a key that equals its preset on the preset", () => {
    expect(initialApiKeyAccess({ ...stored, matchesPreset: true }, presets, "FULL_ACCESS")).toEqual(
      { mode: "preset", presetId: "OBSERVER", capabilities: {}, taskScope: "all", tasks: [] }
    );
  });

  it("opens a key whose scopes differ from its preset on its stored access", () => {
    expect(
      initialApiKeyAccess(
        { ...stored, matchesPreset: false, taskIdentifiers: ["report"] },
        presets,
        "FULL_ACCESS"
      )
    ).toEqual({
      mode: "custom",
      presetId: "OBSERVER",
      capabilities: { tasks: "read", runs: "read", deployments: "read" },
      taskScope: "selected",
      tasks: ["report"],
    });
  });

  it("opens on the preset when updating to what the preset grants today", () => {
    expect(
      initialApiKeyAccess({ ...stored, matchesPreset: false }, presets, "FULL_ACCESS", true).mode
    ).toBe("preset");
  });

  it("opens custom keys and unknown presets on their stored access", () => {
    for (const presetId of ["CUSTOM", "RETIRED_PRESET"]) {
      expect(
        initialApiKeyAccess({ ...stored, presetId, matchesPreset: false }, presets, "FULL_ACCESS")
      ).toMatchObject({
        mode: "custom",
        presetId: "FULL_ACCESS",
        capabilities: stored.capabilities,
      });
    }
  });
});

describe("resolvePresetSelection", () => {
  const chosen = chosenPreset(presets, "apikeypreset_1");

  it("keeps a preset that is still listed", () => {
    expect(resolvePresetSelection(presets, chosen, "TRIGGER_ONLY")).toEqual({
      presetId: "apikeypreset_1",
    });
  });

  it("clears the selection and names the preset when a chosen preset is deleted", () => {
    const remaining = presets.filter((p) => p.id !== "apikeypreset_1");
    expect(resolvePresetSelection(remaining, chosen, "TRIGGER_ONLY")).toEqual({
      presetId: "",
      deletedPresetLabel: "Saved runs",
    });
  });

  it("uses the default for an initial id that was never listed", () => {
    expect(
      resolvePresetSelection(presets, chosenPreset(presets, "MISSING"), "TRIGGER_ONLY")
    ).toEqual({ presetId: "TRIGGER_ONLY" });
  });

  it("uses the default without presets", () => {
    expect(resolvePresetSelection(null, chosen, "FULL_ACCESS")).toEqual({
      presetId: "FULL_ACCESS",
    });
  });
});

describe("requirementReason", () => {
  const streams: ApiKeyCapability = {
    id: "inputStreams",
    label: "Input streams",
    levels: [
      none,
      {
        id: "readWrite",
        label: "Read and write",
        scopes: ["read:inputStreams", "write:inputStreams"],
        requires: [{ capabilityId: "runs", levelIds: ["readWrite"], note: "" }],
      },
    ],
  };
  const sessions: ApiKeyCapability = {
    id: "sessions",
    label: "Sessions",
    levels: [
      none,
      {
        id: "manage",
        label: "Manage",
        scopes: ["admin:sessions"],
        requires: [{ capabilityId: "tasks", levelIds: ["trigger", "readTrigger"], note: "" }],
      },
    ],
  };
  const withRequirements = [...capabilities, streams, sessions];

  it("names the level that locks an area, and the smallest level it needs", () => {
    // Catches: a lock tooltip that names the wrong area or level, or reads as a paragraph.
    expect(
      requirementReason(
        withRequirements,
        { inputStreams: "readWrite" },
        "inputStreams",
        capabilities[1]!
      )
    ).toBe("Input streams: Read and write needs Runs: Read and write.");
    expect(
      requirementReason(withRequirements, { sessions: "manage" }, "sessions", capabilities[0]!)
    ).toBe("Sessions: Manage needs Tasks: Trigger or more.");
  });
});

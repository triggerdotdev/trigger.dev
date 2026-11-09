import { RESTRICTED_API_KEYS_PLAN_MESSAGE } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import { validateApiKeyAccess } from "~/services/apiKeyPresetValidation.server";

const presets = [
  { id: "FULL_ACCESS", available: true, usesTaskSelection: false },
  { id: "DEPLOY_ONLY", available: true, usesTaskSelection: false },
  { id: "ENV_VARS_ONLY", available: false, usesTaskSelection: false },
  { id: "TASK_OPERATOR", available: true, usesTaskSelection: true },
];

describe("validateApiKeyAccess", () => {
  it("rejects an unknown preset id", () => {
    expect(() =>
      validateApiKeyAccess({
        presets,
        presetId: "NOT_A_PRESET",
        taskIdentifiers: [],
        hasTaskParameters: false,
      })
    ).toThrow("Invalid API key access preset");
  });

  it("accepts a listed preset and drops capabilities it doesn't use", () => {
    expect(
      validateApiKeyAccess({
        presets,
        presetId: "DEPLOY_ONLY",
        capabilities: { runs: "read" },
        taskIdentifiers: [],
        hasTaskParameters: false,
      })
    ).toEqual({
      presetId: "DEPLOY_ONLY",
      capabilities: undefined,
      taskIdentifiers: undefined,
    });
  });

  it("passes Custom capabilities and selected tasks through", () => {
    expect(
      validateApiKeyAccess({
        presets,
        presetId: "CUSTOM",
        capabilities: { tasks: "trigger" },
        taskScope: "selected",
        taskIdentifiers: ["send-email"],
        hasTaskParameters: true,
      })
    ).toEqual({
      presetId: "CUSTOM",
      capabilities: { tasks: "trigger" },
      taskIdentifiers: ["send-email"],
    });
  });

  it("says a preset off plan needs the Pro plan", () => {
    expect(() =>
      validateApiKeyAccess({
        presets,
        presetId: "ENV_VARS_ONLY",
        taskIdentifiers: [],
        hasTaskParameters: false,
      })
    ).toThrow(RESTRICTED_API_KEYS_PLAN_MESSAGE);
  });
});

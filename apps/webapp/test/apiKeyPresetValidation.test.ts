import {
  DELETED_API_KEY_PRESET_MESSAGE,
  RESTRICTED_API_KEYS_PLAN_MESSAGE,
} from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  canManageApiKeyPresets,
  validateApiKeyAccess,
} from "~/services/apiKeyPresetValidation.server";

const presets = [
  { id: "FULL_ACCESS", available: true, usesTaskSelection: false },
  { id: "DEPLOY_ONLY", available: true, usesTaskSelection: false },
  { id: "ENV_VARS_ONLY", available: false, usesTaskSelection: false },
  { id: "apikeypreset_kept", available: true, usesTaskSelection: true },
];

describe("validateApiKeyAccess", () => {
  it("says a saved preset that is no longer listed was deleted", () => {
    expect(() =>
      validateApiKeyAccess({
        presets,
        presetId: "apikeypreset_gone",
        taskIdentifiers: [],
        hasTaskParameters: false,
      })
    ).toThrow(DELETED_API_KEY_PRESET_MESSAGE);
  });

  it("rejects an unknown preset id that isn't a saved preset", () => {
    expect(() =>
      validateApiKeyAccess({
        presets,
        presetId: "NOT_A_PRESET",
        taskIdentifiers: [],
        hasTaskParameters: false,
      })
    ).toThrow("Invalid API key access preset");
  });

  it("accepts a listed saved preset", () => {
    expect(
      validateApiKeyAccess({
        presets,
        presetId: "apikeypreset_kept",
        taskIdentifiers: [],
        hasTaskParameters: false,
      })
    ).toEqual({
      presetId: "apikeypreset_kept",
      capabilities: undefined,
      taskIdentifiers: undefined,
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

describe("canManageApiKeyPresets", () => {
  const developer = {
    can: (_action: string, subject: unknown) =>
      (subject as { envType?: string }).envType === "DEVELOPMENT",
  };
  const admin = { can: () => true };

  it("refuses a role that can only write Development API keys", () => {
    expect(canManageApiKeyPresets(developer as never)).toBe(false);
  });

  it("allows a role that can write deployed API keys", () => {
    expect(canManageApiKeyPresets(admin as never)).toBe(true);
  });
});

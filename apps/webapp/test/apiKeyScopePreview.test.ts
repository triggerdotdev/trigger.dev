import { describe, expect, it } from "vitest";
import { getApiKeyScopePreview } from "~/utils/apiKeyScopePreview";

describe("getApiKeyScopePreview", () => {
  it("renders a plugin-defined preset from its scopes without treating it as full access", () => {
    const preview = getApiKeyScopePreview({
      preset: {
        label: "Log viewer",
        scopes: ["read:logs"],
        usesTaskSelection: false,
      },
      selectedTasks: [],
    });

    expect(preview).toEqual({
      fullAccess: false,
      scopes: ["read:logs"],
    });
  });

  it("expands selected task scopes from the plugin-generated template", () => {
    const preview = getApiKeyScopePreview({
      preset: {
        label: "Task operator",
        scopes: ["trigger:tasks", "read:tasks", "batchTrigger:batch"],
        usesTaskSelection: true,
      },
      taskScope: "selected",
      selectedTasks: ["send-email", "sync-customer"],
    });

    expect(preview.scopes).toEqual([
      "trigger:tasks:send-email",
      "trigger:tasks:sync-customer",
      "read:tasks:send-email",
      "read:tasks:sync-customer",
      "batchTrigger:batch",
    ]);
  });
});

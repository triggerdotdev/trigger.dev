import { describe, expect, it } from "vitest";
import { mergeHiddenItems } from "~/utils/dashboardPreferences";

describe("mergeHiddenItems", () => {
  it("leaves ids the dialog never rendered alone", () => {
    const result = mergeHiddenItems({ logs: true, queues: true }, { queues: false }, ["queues"]);
    expect(result).toEqual({ logs: true, queues: false });
  });

  it("keeps out-of-scope ids when the submission resets to defaults", () => {
    const result = mergeHiddenItems({ logs: true, queues: true }, null, ["queues"]);
    expect(result).toEqual({ logs: true });
  });

  it("treats the submission as authoritative without a known-id list", () => {
    const result = mergeHiddenItems({ logs: true, queues: true }, { queues: false }, undefined);
    expect(result).toEqual({ queues: false });
  });

  it("clears the stored map when nothing is left hidden", () => {
    expect(mergeHiddenItems({ queues: true }, null, ["queues"])).toBeUndefined();
    expect(mergeHiddenItems(undefined, null, undefined)).toBeUndefined();
  });

  it("lets the submission win for ids it did render", () => {
    const result = mergeHiddenItems({ queues: true }, { queues: false }, ["queues", "logs"]);
    expect(result).toEqual({ queues: false });
  });
});

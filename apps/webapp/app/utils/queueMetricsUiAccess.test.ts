import { describe, expect, it } from "vitest";
import { resolveQueueMetricsUiAccess } from "./queueMetricsUiAccess";

describe("resolveQueueMetricsUiAccess", () => {
  it("allows access when the org flag is on", () => {
    expect(
      resolveQueueMetricsUiAccess({
        flagEnabled: true,
        isImpersonating: false,
        isViewingAsUser: false,
      })
    ).toBe(true);
  });

  it("denies access when the org flag is off and the session is not impersonating", () => {
    expect(
      resolveQueueMetricsUiAccess({
        flagEnabled: false,
        isImpersonating: false,
        isViewingAsUser: false,
      })
    ).toBe(false);
  });

  it("allows an impersonating admin to preview the UI with the org flag off", () => {
    expect(
      resolveQueueMetricsUiAccess({
        flagEnabled: false,
        isImpersonating: true,
        isViewingAsUser: false,
      })
    ).toBe(true);
  });

  it("withholds the preview while the admin is viewing as the user", () => {
    expect(
      resolveQueueMetricsUiAccess({
        flagEnabled: false,
        isImpersonating: true,
        isViewingAsUser: true,
      })
    ).toBe(false);
  });

  it("keeps access for an org whose flag is on even while viewing as the user", () => {
    expect(
      resolveQueueMetricsUiAccess({
        flagEnabled: true,
        isImpersonating: true,
        isViewingAsUser: true,
      })
    ).toBe(true);
  });
});

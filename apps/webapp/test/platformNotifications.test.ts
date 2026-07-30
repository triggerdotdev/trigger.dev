import { describe, expect, it } from "vitest";
import { CreatePlatformNotificationSchema } from "~/services/platformNotificationSchemas";
import { isCliVersionEligible } from "~/services/platformNotificationVersionTargeting";

function createNotificationInput({
  surface = "CLI",
  minimumCliVersion,
}: {
  surface?: "CLI" | "WEBAPP";
  minimumCliVersion?: string;
} = {}) {
  return {
    title: "Notification",
    surface,
    scope: "GLOBAL" as const,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    payload: {
      version: "1" as const,
      data: {
        type: surface === "CLI" ? ("info" as const) : ("card" as const),
        title: "Update available",
        description: "Update the CLI",
        ...(minimumCliVersion === undefined ? {} : { minimumCliVersion }),
      },
    },
  };
}

describe("platform notification minimum CLI version schema", () => {
  it("keeps existing unrestricted CLI payloads valid", () => {
    const result = CreatePlatformNotificationSchema.safeParse(createNotificationInput());

    expect(result.success).toBe(true);
  });

  it("trims and accepts a complete exact SemVer", () => {
    const result = CreatePlatformNotificationSchema.parse(
      createNotificationInput({ minimumCliVersion: " 4.5.7-beta.1+build.2 " })
    );

    expect(result.payload.data.minimumCliVersion).toBe("4.5.7-beta.1+build.2");
  });

  it.each(["4.5", ">=4.5.7", "4.5.x", "v4.5.7", "4.5.7 or newer", "01.2.3"])(
    "rejects non-exact SemVer %s",
    (minimumCliVersion) => {
      const result = CreatePlatformNotificationSchema.safeParse(
        createNotificationInput({ minimumCliVersion })
      );

      expect(result.success).toBe(false);
    }
  );

  it("rejects minimumCliVersion for WEBAPP notifications", () => {
    const result = CreatePlatformNotificationSchema.safeParse(
      createNotificationInput({ surface: "WEBAPP", minimumCliVersion: "4.5.7" })
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["payload", "data", "minimumCliVersion"] })
      );
    }
  });
});

describe("CLI notification version eligibility", () => {
  it("allows unrestricted notifications without a request version", () => {
    expect(isCliVersionEligible(undefined, undefined)).toBe(true);
  });

  it.each([undefined, "", "4.5", "not-a-version"])(
    "rejects a targeted notification for missing or malformed request version %s",
    (cliVersion) => {
      expect(isCliVersionEligible("4.5.7", cliVersion)).toBe(false);
    }
  );

  it("fails closed for an invalid stored minimum version", () => {
    expect(isCliVersionEligible(">=4.5.7", "4.6.0")).toBe(false);
  });

  it.each([
    ["4.5.6", false],
    ["4.5.7-beta.1", false],
    ["4.5.7", true],
    ["4.5.7+build.9", true],
    ["4.6.0", true],
  ])("compares %s against inclusive minimum 4.5.7", (cliVersion, expected) => {
    expect(isCliVersionEligible("4.5.7", cliVersion)).toBe(expected);
  });

  it("uses SemVer precedence for prerelease minimums", () => {
    expect(isCliVersionEligible("4.5.7-beta.2", "4.5.7-beta.1")).toBe(false);
    expect(isCliVersionEligible("4.5.7-beta.2", "4.5.7-beta.2+build.1")).toBe(true);
    expect(isCliVersionEligible("4.5.7-beta.2", "4.5.7")).toBe(true);
  });
});

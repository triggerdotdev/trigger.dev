import { describe, expect, it } from "vitest";
import {
  activeSigningSecrets,
  MAX_PREVIOUS_SECRET_TTL_SECONDS,
  PreviousSecretTtlSeconds,
  replaceStoredSigningSecret,
} from "~/v3/webhookSigningSecret";

const now = new Date("2026-10-20T12:00:00.000Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);

describe("replaceStoredSigningSecret", () => {
  it("stores only the new secret when there is no grace window", () => {
    expect(replaceStoredSigningSecret({ secret: "old" }, "new", 0, now)).toEqual({
      secret: "new",
    });
  });

  it("stores only the new secret when nothing was set before", () => {
    expect(replaceStoredSigningSecret(undefined, "new", 3600, now)).toEqual({ secret: "new" });
  });

  it("keeps the replaced secret until the grace window ends", () => {
    expect(replaceStoredSigningSecret({ secret: "old" }, "new", 3600, now)).toEqual({
      secret: "new",
      previous: { secret: "old", expiresAt: "2026-10-20T13:00:00.000Z" },
    });
  });

  it("keeps only the latest replaced secret across back-to-back rotations", () => {
    const first = replaceStoredSigningSecret({ secret: "a" }, "b", 3600, now);
    const second = replaceStoredSigningSecret(first, "c", 3600, now);
    expect(second).toEqual({
      secret: "c",
      previous: { secret: "b", expiresAt: "2026-10-20T13:00:00.000Z" },
    });
  });

  it("re-setting the same secret keeps its grace window, or ends it with no window", () => {
    const rotated = replaceStoredSigningSecret({ secret: "old" }, "new", 3600, now);
    expect(replaceStoredSigningSecret(rotated, "new", 3600, later(60))).toEqual(rotated);
    expect(replaceStoredSigningSecret(rotated, "new", 0, later(60))).toEqual({ secret: "new" });
  });
});

describe("activeSigningSecrets", () => {
  const rotated = replaceStoredSigningSecret({ secret: "old" }, "new", 3600, now);

  it("lists the current secret first, then the previous one inside its window", () => {
    expect(activeSigningSecrets(rotated, later(3599))).toEqual(["new", "old"]);
  });

  it("drops the previous secret once it expires", () => {
    expect(activeSigningSecrets(rotated, later(3600))).toEqual(["new"]);
  });

  it("reads secrets stored before rotation support", () => {
    expect(activeSigningSecrets({ secret: "only" }, now)).toEqual(["only"]);
  });

  it("is empty when nothing usable is stored", () => {
    expect(activeSigningSecrets(undefined, now)).toEqual([]);
    expect(activeSigningSecrets({ secret: "" }, now)).toEqual([]);
  });
});

describe("PreviousSecretTtlSeconds", () => {
  it("accepts zero up to seven days", () => {
    expect(PreviousSecretTtlSeconds.safeParse(0).success).toBe(true);
    expect(PreviousSecretTtlSeconds.safeParse(MAX_PREVIOUS_SECRET_TTL_SECONDS).success).toBe(true);
    expect(PreviousSecretTtlSeconds.safeParse(MAX_PREVIOUS_SECRET_TTL_SECONDS + 1).success).toBe(
      false
    );
    expect(PreviousSecretTtlSeconds.safeParse(-1).success).toBe(false);
    expect(PreviousSecretTtlSeconds.safeParse(1.5).success).toBe(false);
  });
});

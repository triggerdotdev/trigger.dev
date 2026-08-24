import { signUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { describe, expect, it } from "vitest";
import {
  WATCH_TOKEN_GRACE_MS,
  WATCH_TOKEN_PREFIX,
  isDashboardAgentWatchToken,
  signDashboardAgentWatchToken,
  verifyDashboardAgentWatchToken,
} from "~/services/dashboardAgentWatchToken.server";

const SECRET = "test-session-secret-for-watch-tokens";
const USER_ACTOR_PREFIX = "tr_uat_";

function inAnHour(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

describe("dashboard agent watch tokens", () => {
  it("round-trips the watch id", async () => {
    const expiresAt = inAnHour();
    const token = await signDashboardAgentWatchToken(SECRET, { watchId: "watch_abc", expiresAt });

    expect(isDashboardAgentWatchToken(token)).toBe(true);

    const claims = await verifyDashboardAgentWatchToken(SECRET, token);
    expect(claims?.watchId).toBe("watch_abc");
    // exp = expiresAt + the grace window, to the second.
    expect(claims?.expiresAtSeconds).toBe(
      Math.floor((expiresAt.getTime() + WATCH_TOKEN_GRACE_MS) / 1000)
    );
  });

  it("is deterministic, so the scheduler can re-mint instead of storing it", async () => {
    const expiresAt = inAnHour();
    const a = await signDashboardAgentWatchToken(SECRET, { watchId: "watch_abc", expiresAt });
    const b = await signDashboardAgentWatchToken(SECRET, { watchId: "watch_abc", expiresAt });
    expect(a).toBe(b);
  });

  it("rejects another secret's signature", async () => {
    const token = await signDashboardAgentWatchToken(SECRET, {
      watchId: "watch_abc",
      expiresAt: inAnHour(),
    });
    expect(await verifyDashboardAgentWatchToken("a-different-secret", token)).toBeUndefined();
  });

  it("stays valid through the grace window and dies after it", async () => {
    // expiresAt just passed: the token still verifies, because the final check happens after the deadline.
    const justExpired = new Date(Date.now() - 60_000);
    const graceful = await signDashboardAgentWatchToken(SECRET, {
      watchId: "watch_abc",
      expiresAt: justExpired,
    });
    expect(await verifyDashboardAgentWatchToken(SECRET, graceful)).toMatchObject({
      watchId: "watch_abc",
    });

    const longGone = await signDashboardAgentWatchToken(SECRET, {
      watchId: "watch_abc",
      expiresAt: new Date(Date.now() - WATCH_TOKEN_GRACE_MS - 60_000),
    });
    expect(await verifyDashboardAgentWatchToken(SECRET, longGone)).toBeUndefined();
  });

  describe("cross-rejection with user-actor tokens", () => {
    it("the UAT verifier rejects a watch token", async () => {
      const watchToken = await signDashboardAgentWatchToken(SECRET, {
        watchId: "watch_abc",
        expiresAt: inAnHour(),
      });
      expect(await verifyUserActorToken(SECRET, watchToken)).toBeUndefined();
    });

    it("the watch verifier rejects a user-actor token", async () => {
      const uat = await signUserActorToken(SECRET, {
        userId: "user_1",
        client: "dashboard-agent",
        cap: ["read:runs"],
      });
      expect(await verifyDashboardAgentWatchToken(SECRET, uat)).toBeUndefined();
    });

    it("re-prefixing a UAT as a watch token doesn't help — the kind claim disagrees", async () => {
      const uat = await signUserActorToken(SECRET, {
        userId: "user_1",
        client: "dashboard-agent-watch",
        cap: ["read:runs"],
      });
      const disguised = `${WATCH_TOKEN_PREFIX}${uat.slice(USER_ACTOR_PREFIX.length)}`;

      expect(isDashboardAgentWatchToken(disguised)).toBe(true);
      expect(await verifyDashboardAgentWatchToken(SECRET, disguised)).toBeUndefined();
    });

    it("re-prefixing a watch token as a UAT doesn't help either", async () => {
      const watchToken = await signDashboardAgentWatchToken(SECRET, {
        watchId: "watch_abc",
        expiresAt: inAnHour(),
      });
      const disguised = `${USER_ACTOR_PREFIX}${watchToken.slice(WATCH_TOKEN_PREFIX.length)}`;

      expect(await verifyUserActorToken(SECRET, disguised)).toBeUndefined();
    });
  });
});

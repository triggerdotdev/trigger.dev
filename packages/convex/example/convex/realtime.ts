"use node";

import { auth } from "@trigger.dev/sdk";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const TOKEN_LIFETIME_MS = 10 * 60_000;
const TOKEN_RENEWAL_MARGIN_MS = 60_000;
type Credentials = { accessToken: string; baseURL: string; expiresAt: number; runId: string };

export const token = action({
  args: { jobId: v.id("edits"), sessionToken: v.string() },
  handler: async (ctx, args): Promise<Credentials | null> => {
    const access = await ctx.runQuery(internal.jobs.realtimeAccess, args);
    if (!access) return null;
    const baseURL = process.env.TRIGGER_API_URL;
    if (!baseURL) throw new Error("Trigger API is not configured");
    if (
      access.cached?.runId === access.runId &&
      access.cached.expiresAt > Date.now() + TOKEN_RENEWAL_MARGIN_MS
    ) {
      return { ...access.cached, baseURL };
    }
    const expiresAt = Math.min(Date.now() + TOKEN_LIFETIME_MS, access.expiresAt);
    if (expiresAt <= Date.now()) return null;
    let accessToken: string;
    try {
      accessToken = await auth.withAuth(
        { secretKey: process.env.TRIGGER_SECRET_KEY, baseURL },
        () =>
          auth.createPublicToken({
            scopes: { read: { runs: [access.runId] } },
            expirationTime: new Date(expiresAt),
            realtime: { skipColumns: ["payload", "output"] },
          })
      );
    } catch {
      throw new Error("Live updates are unavailable. Convex will continue syncing this job.");
    }
    await ctx.runMutation(internal.jobs.cacheRealtimeToken, {
      ...args,
      runId: access.runId,
      accessToken,
      expiresAt,
    });
    return { accessToken, baseURL, expiresAt, runId: access.runId };
  },
});

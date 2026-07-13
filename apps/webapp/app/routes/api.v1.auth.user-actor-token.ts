import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { signUserActorToken } from "@trigger.dev/rbac";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";

// Callers pick the TTL (default 1h) up to a hard ceiling; renewal = mint again
// with the PAT. The default is short, but the ceiling allows long-lived tokens
// for callers that need them (e.g. a long-running integration).
const DEFAULT_UAT_TTL_SECONDS = 60 * 60; // 1 hour
const MAX_UAT_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days

// Mint a short-lived delegated user-actor token (`tr_uat_`) from a personal
// access token. A UAT is a strict downgrade of the PAT: same user identity,
// short-lived, optionally narrowed by `cap`. It lets a holder (an agent, the
// MCP server, an IDE) act as the user without carrying a long-lived PAT.
const RequestBodySchema = z
  .object({
    // Optional scope cap (e.g. ["read:runs"]) — ceilings the UAT below the
    // user's role. Absent → identity-only, floored by the user's role at
    // use-time.
    cap: z.array(z.string()).optional(),
    // Attribution label recorded in the token's `act.client` (e.g. the agent
    // or tool that requested it).
    client: z.string().min(1).max(255).optional(),
    // Lifetime in seconds. Omitted → 1h. Over the ceiling → 400 (we don't
    // silently clamp, so a caller never thinks it got longer than it did).
    ttlSeconds: z.number().int().positive().max(MAX_UAT_TTL_SECONDS).optional(),
  })
  .optional();

export async function action({ request }: ActionFunctionArgs) {
  try {
    // Mint only from a real PAT. authenticatePat requires the `tr_pat_`
    // prefix, so a UAT can't mint another UAT (no indefinite renewal) and an
    // env API key / OAT can't mint one either.
    const patAuth = await rbac.authenticatePat(request, {});
    if (!patAuth.ok) {
      return json({ error: patAuth.error }, { status: patAuth.status });
    }

    // A role-restricted PAT (one with a TokenRole cap) can't mint a UAT: the
    // UAT is floored by the user's role at use-time and wouldn't carry the
    // PAT's narrower ceiling, so minting would widen the grant. Reject rather
    // than silently escalate. (The OSS fallback has no TokenRoles, so this
    // only takes effect with the cloud RBAC plugin installed.)
    const tokenRole = await rbac.getTokenRole(patAuth.tokenId);
    if (tokenRole) {
      return json(
        {
          error: "Cannot mint a user-actor token from a role-restricted personal access token",
        },
        { status: 403 }
      );
    }

    const parsedBody = RequestBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) {
      return json(
        { error: "Invalid request body", issues: parsedBody.error.issues },
        { status: 400 }
      );
    }
    const body = parsedBody.data ?? {};
    const ttlSeconds = body.ttlSeconds ?? DEFAULT_UAT_TTL_SECONDS;

    const token = await signUserActorToken(env.SESSION_SECRET, {
      userId: patAuth.userId,
      client: body.client ?? "personal-access-token",
      cap: body.cap,
      // Absolute exp (seconds since epoch). jose treats a number as absolute.
      expirationTime: Math.floor(Date.now() / 1000) + ttlSeconds,
    });

    return json({ token, expiresInSeconds: ttlSeconds });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to mint user-actor token", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}

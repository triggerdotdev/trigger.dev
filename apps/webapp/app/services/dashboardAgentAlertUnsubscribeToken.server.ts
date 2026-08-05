/**
 * The credential in a watch alert email's "Turn off these alerts" link. Same
 * construction as the watch token: HS256 over `SESSION_SECRET` with a disjoint prefix
 * and `kind` claim, so no other token signed with that secret is accepted here.
 *
 * It authorizes one action on one named channel and alert type, which is why it can be
 * long-lived and needs no session: the worst a leaked link does is silence one alert
 * type on one channel, re-enabled on the Alerts page.
 *
 * Nothing is stored; the link is re-minted from the channel id whenever an email is
 * sent.
 */

import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { env } from "~/env.server";

const UNSUBSCRIBE_TOKEN_PREFIX = "tr_daau_";
const UNSUBSCRIBE_TOKEN_KIND = "dashboard_agent_alert_unsubscribe";
const UNSUBSCRIBE_PURPOSE = "unsubscribe";

/** Long-lived: an alert email has to keep working months after it arrived. */
const UNSUBSCRIBE_TOKEN_TTL = "365d";

export type UnsubscribeTokenClaims = { channelId: string; alertType: string };

export async function signDashboardAgentAlertUnsubscribeToken(
  secret: string,
  opts: { channelId: string; alertType: string }
): Promise<string> {
  const jwt = await generateJWT({
    secretKey: secret,
    payload: {
      kind: UNSUBSCRIBE_TOKEN_KIND,
      purpose: UNSUBSCRIBE_PURPOSE,
      sub: opts.channelId,
      alertType: opts.alertType,
    },
    expirationTime: UNSUBSCRIBE_TOKEN_TTL,
  });

  return `${UNSUBSCRIBE_TOKEN_PREFIX}${jwt}`;
}

export async function verifyDashboardAgentAlertUnsubscribeToken(
  secret: string,
  token: string
): Promise<UnsubscribeTokenClaims | undefined> {
  if (!token.startsWith(UNSUBSCRIBE_TOKEN_PREFIX)) return;

  const result = await validateJWT(token.slice(UNSUBSCRIBE_TOKEN_PREFIX.length), secret);
  if (!result.ok) return;

  const payload = result.payload;
  if (payload.kind !== UNSUBSCRIBE_TOKEN_KIND) return;
  if (payload.purpose !== UNSUBSCRIBE_PURPOSE) return;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return;
  if (typeof payload.alertType !== "string" || payload.alertType.length === 0) return;

  return { channelId: payload.sub, alertType: payload.alertType };
}

/** Mint the token for a channel, using the platform secret. */
export function mintDashboardAgentAlertUnsubscribeToken(opts: {
  channelId: string;
  alertType: string;
}): Promise<string> {
  return signDashboardAgentAlertUnsubscribeToken(env.SESSION_SECRET, opts);
}

export function verifyUnsubscribeToken(token: string): Promise<UnsubscribeTokenClaims | undefined> {
  return verifyDashboardAgentAlertUnsubscribeToken(env.SESSION_SECRET, token);
}

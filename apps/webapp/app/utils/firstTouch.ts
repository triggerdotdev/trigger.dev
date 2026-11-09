import { z } from "zod";

// How a user first reached us (first-touch UTMs, referrer and landing page), as stored by PostHog.
export const FirstTouchSchema = z.object({
  utmSource: z.string().optional(),
  utmMedium: z.string().optional(),
  utmCampaign: z.string().optional(),
  referrer: z.string().optional(),
  landingPage: z.string().optional(),
});
export type FirstTouch = z.infer<typeof FirstTouchSchema>;

const MAX_VALUE_LENGTH = 200;
const MAX_URL_LENGTH = 500;

// Maps PostHog's `$initial_*` person props to our shape.
export function firstTouchFromPostHogProps(props: Record<string, unknown> | undefined): FirstTouch {
  if (!props) return {};
  return {
    utmSource: asString(props.$initial_utm_source),
    utmMedium: asString(props.$initial_utm_medium),
    utmCampaign: asString(props.$initial_utm_campaign),
    referrer: asString(props.$initial_referring_domain),
    landingPage: asString(props.$initial_current_url),
  };
}

// Parses the form's JSON field. Never throws: bad input means no first touch.
export function parseFirstTouch(raw: unknown): FirstTouch | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 5_000) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = FirstTouchSchema.safeParse(json);
  if (!parsed.success) return undefined;

  const firstTouch: FirstTouch = {
    utmSource: clean(parsed.data.utmSource),
    utmMedium: clean(parsed.data.utmMedium),
    utmCampaign: clean(parsed.data.utmCampaign),
    referrer: clean(parsed.data.referrer),
    landingPage: cleanUrl(parsed.data.landingPage),
  };

  const present = Object.entries(firstTouch).filter(([, value]) => value !== undefined);
  return present.length > 0 ? (Object.fromEntries(present) as FirstTouch) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_VALUE_LENGTH) : undefined;
}

// Origin + path only: query strings and hashes can carry tokens or emails, and so can path
// segments, so ones that look like an email, token or id are replaced with ":id".
function cleanUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname
      .split("/")
      .map((segment) => (looksSensitive(segment) ? ":id" : segment))
      .join("/");
    return `${url.origin}${path}`.slice(0, MAX_URL_LENGTH);
  } catch {
    return undefined;
  }
}

// Emails, UUIDs and long digit-bearing tokens; hyphenated slugs like blog post names are kept.
function looksSensitive(segment: string): boolean {
  const decoded = safeDecode(segment);
  if (decoded.includes("@")) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return true;
  return decoded.length >= 16 && /\d/.test(decoded) && !decoded.includes("-");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

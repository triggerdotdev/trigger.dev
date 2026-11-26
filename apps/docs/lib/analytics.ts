import type { PostHog } from "posthog-js";
import { redact } from "./redact";
import { hasSignedInHint } from "./reader";

// Public settings, inlined at build time. Without a key nothing loads and track() is a no-op.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com";

let client: Promise<PostHog> | undefined;

function doNotTrack() {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

// The marketing site on the same domain records its cookie banner choice here.
function hasAnalyticsConsent() {
  try {
    const raw = document.cookie.match(/(?:^|; )cc_cookie=([^;]*)/)?.[1];
    if (!raw) return false;
    const categories = JSON.parse(decodeURIComponent(raw)).categories as unknown;
    return Array.isArray(categories) && categories.includes("analytics");
  } catch {
    return false;
  }
}

function optedOut() {
  try {
    return localStorage.getItem("analytics_opted_out") === "true";
  } catch {
    return false;
  }
}

/** Loads PostHog once, in the browser, when a key is set and the reader hasn't opted out. */
export function analytics(): Promise<PostHog> | undefined {
  if (!key || typeof window === "undefined" || doNotTrack() || optedOut()) return;
  return (client ??= import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: host,
      // Page views on first load and on every client-side navigation.
      capture_pageview: "history_change",
      capture_pageleave: true,
      autocapture: false,
      disable_session_recording: true,
      respect_dnt: true,
      // No cookies unless the reader accepted analytics on the marketing site's banner.
      persistence: hasAnalyticsConsent() ? "localStorage+cookie" : "memory",
      // Our own cookie, never the dashboard's cross-subdomain one: that carries the signed-in
      // user and their org and project, which must not join the docs events.
      persistence_name: "docs",
      // Page URLs carry readers' text too (`?q=`), so they're redacted like track()'s properties.
      before_send: redactUrls,
    });
    // `signed_in`: the dashboard's hint cookie, no identity. The cutover reads the signed-in share from it.
    posthog.register({ site: "docs", signed_in: hasSignedInHint(document.cookie) });
    return posthog;
  }));
}

type Props = Record<string, unknown> | undefined;

// Percent-encoding hides what redact() looks for (`%20tr_dev_...`).
function decoded(url: string) {
  try {
    return decodeURIComponent(url.replace(/\+/g, " "));
  } catch {
    return url;
  }
}

/** Redacts every URL and referrer property PostHog adds by itself, on the event and the person. */
export function redactUrls<E extends { properties?: Props; $set?: Props; $set_once?: Props }>(
  event: E | null
): E | null {
  for (const bag of [event?.properties, event?.$set, event?.$set_once]) {
    for (const [k, v] of Object.entries(bag ?? {}))
      if (/url|referrer/i.test(k) && typeof v === "string") bag![k] = redact(decoded(v));
  }
  return event;
}

type DocsEvent =
  | "docs_search"
  | "docs_search_result_clicked"
  | "docs_ask_ai_asked"
  | "docs_ask_ai_answered"
  | "docs_ask_ai_continued"
  | "docs_ask_ai_citation_clicked"
  | "docs_ask_ai_feedback"
  | "docs_page_feedback"
  | "docs_copy_markdown"
  | "docs_copy_prompt"
  | "docs_open_in_ai"
  | "docs_reader_error"
  | "docs_not_found";

export function track(event: DocsEvent, properties: Record<string, unknown> = {}) {
  const redacted = Object.fromEntries(
    Object.entries(properties).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])
  );
  void analytics()?.then((posthog) => posthog.capture(event, redacted));
}

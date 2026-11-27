"use client";

import { useEffect, useSyncExternalStore } from "react";
import { dashboardLink, personalizationEnabled } from "./dashboard-link";
import { basePath } from "./base-path";
import { track } from "./analytics";
import { keepKeysOf } from "./docs-keys";

// The reader seam: who is reading the docs. Fetched in the browser from the dashboard with the
// reader's session cookie, never in the server render or the CDN cache. Anonymous when
// personalization is off, when signed out, and on any error.

export type ReaderProject = { ref: string; name: string; orgTitle: string };

export type Reader =
  | { kind: "anonymous" }
  | { kind: "loading" }
  | {
      kind: "signed-in";
      user: { id: string; name: string | null; avatarUrl: string | null };
      projects: ReaderProject[];
      /** The project picked in the docs, else the one the dashboard would open. */
      project: ReaderProject | null;
    };

// The response of apps/webapp/app/routes/resources.docs.me.ts (DocsReader there).
type MeResponse = {
  user: { id: string; name: string | null; avatarUrl: string | null };
  organizations: { title: string; projects: { ref: string; name: string }[] }[];
  lastProjectRef: string | null;
};

const PICKED_KEY = "trigger-docs:project";
const anonymous: Reader = { kind: "anonymous" };
const loading: Reader = { kind: "loading" };

let me: MeResponse | null = null;
let state: Reader = personalizationEnabled ? loading : anonymous;
let started = false;
const listeners = new Set<() => void>();

function readPicked(): string | null {
  try {
    return localStorage.getItem(PICKED_KEY);
  } catch {
    return null;
  }
}

// `?project=<ref>` on an embed page: the dashboard's current project, for this view only.
function embedProject(): string | null {
  try {
    const url = new URL(window.location.href);
    return url.pathname.startsWith(`${basePath}/embed/`) ? url.searchParams.get("project") : null;
  } catch {
    return null;
  }
}

function update() {
  if (!me) return;
  const projects = me.organizations.flatMap((org) =>
    org.projects.map((p) => ({ ref: p.ref, name: p.name, orgTitle: org.title }))
  );
  const picked = readPicked();
  const project =
    projects.find((p) => p.ref === embedProject()) ??
    projects.find((p) => p.ref === picked) ??
    projects.find((p) => p.ref === me?.lastProjectRef) ??
    projects[0] ??
    null;
  state = { kind: "signed-in", user: me.user, projects, project };
  listeners.forEach((l) => l());
}

function setState(next: Reader) {
  state = next;
  listeners.forEach((l) => l());
}

/** The dashboard sets `docs_signed_in=1` while someone is signed in (and clears it at sign-out), so
 * anonymous readers never ask it who they are. The `me` answer still decides. */
export function hasSignedInHint(cookies: string): boolean {
  return /(?:^|;\s*)docs_signed_in=1(?:;|$)/.test(cookies);
}

let lastChecked = 0;

/** Signed out (no hint cookie, or the session ended): personal values and this tab's docs keys go. */
function signedOut() {
  me = null;
  keepKeysOf(""); // no owner: forgets every docs key this tab holds
  setState(anonymous);
}

// Signing out or switching accounts happens in a dashboard tab, so a docs tab asks again when the
// reader comes back to it (at most once a minute).
function recheck() {
  if (document.visibilityState !== "visible" || Date.now() - lastChecked < 60_000) return;
  started = false;
  load();
}

function load() {
  if (started || !personalizationEnabled) return;
  if (!lastChecked) document.addEventListener("visibilitychange", recheck);
  started = true;
  lastChecked = Date.now();
  if (!hasSignedInHint(document.cookie)) return signedOut();
  // A hung dashboard makes the reader anonymous after 10 s instead of "loading" for minutes.
  fetch(dashboardLink("/resources/docs/me"), {
    credentials: "include",
    signal: AbortSignal.timeout(10_000),
  })
    .then<MeResponse | "signed-out" | null>((res) => {
      if (res.status === 401) return "signed-out";
      // Anything else means personalization is failing for this reader, not that they signed out.
      if (!res.ok) track("docs_reader_error", { status: res.status });
      return res.ok ? (res.json() as Promise<MeResponse>) : null;
    })
    .then((body) => {
      if (body === "signed-out") return signedOut();
      if (!body) return setState(anonymous);
      keepKeysOf(body.user.id);
      me = body;
      update();
    })
    .catch(() => {
      // Blocked by CORS, dashboard unreachable or too slow, or a body that isn't JSON.
      track("docs_reader_error", { status: 0 });
      setState(anonymous);
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReader(): Reader {
  useEffect(load, []);
  // The server render, and hydration, are always anonymous; the reader arrives after.
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => anonymous
  );
}

/** The signed-in reader's project, or null. */
export function useReaderProject(): ReaderProject | null {
  const reader = useReader();
  return reader.kind === "signed-in" ? reader.project : null;
}

/** Remember the picked project in this browser. */
export function pickProject(ref: string) {
  try {
    localStorage.setItem(PICKED_KEY, ref);
  } catch {}
  update();
}

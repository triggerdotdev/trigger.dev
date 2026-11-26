"use client";

import { useSyncExternalStore } from "react";
import { covers } from "./api-access";
import { dashboardLink } from "./dashboard-link";
import type { ReaderProject } from "./reader";

// Keys created from the docs this tab, newest first. The dashboard returns a key's plaintext once,
// on creation; nothing reads a key back from it. sessionStorage only: gone when the tab closes.
export type DocsKey = {
  projectRef: string;
  env: "dev";
  name: string;
  apiKey: string;
  apiUrl: string;
  /** What it was created for; null is the default docs key. */
  access: string[] | null;
  /** What it can do; null when unrestricted. */
  scopes: string[] | null;
  created: string;
};

const KEYS = "trigger-docs:keys";
let docsKeys: DocsKey[] | undefined;
const noKeys: DocsKey[] = [];

function storedKeys(): DocsKey[] {
  if (docsKeys === undefined) {
    try {
      docsKeys = JSON.parse(sessionStorage.getItem(KEYS) ?? "[]") as DocsKey[];
    } catch {
      docsKeys = [];
    }
  }
  return docsKeys;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function saveKeys(next: DocsKey[]) {
  docsKeys = next;
  try {
    sessionStorage.setItem(KEYS, JSON.stringify(next));
  } catch {}
  listeners.forEach((l) => l());
}

export function useDocsKeys(): DocsKey[] {
  return useSyncExternalStore(subscribe, storedKeys, () => noKeys);
}

/** The first key this tab has for `projectRef` that grants `needed`. */
export function pickKey(keys: DocsKey[], projectRef: string, needed: string[]) {
  return keys.find((k) => k.projectRef === projectRef && covers(k.scopes, needed)) ?? null;
}

/** Why a key wasn't created, in words for the reader. `signIn`: offer the sign-in link. */
export class DocsKeyError extends Error {
  constructor(
    message: string,
    readonly signIn = false
  ) {
    super(message);
  }
}

/** The reader's message for a failed key creation, from the dashboard's status and error. */
export function keyCreationError(
  status: number,
  error: string | undefined,
  retryAfter: string | null
): DocsKeyError {
  if (status === 401) return new DocsKeyError("Your dashboard session ended. Sign in again.", true);
  if (status === 404)
    return new DocsKeyError(
      error === "No dev environment"
        ? "You don't have a development environment in this project yet. Open it in the dashboard first."
        : "You no longer have access to this project. Pick another one."
    );
  if (status === 429) {
    const minutes = Math.ceil(Number(retryAfter) / 60);
    const when = !minutes ? "later" : minutes === 1 ? "in a minute" : `in ${minutes} minutes`;
    return new DocsKeyError(`Too many keys created. Try again ${when}.`);
  }
  if (status === 403 && !error?.startsWith("Your role"))
    return new DocsKeyError("You can't create dev keys in this project.");
  return new DocsKeyError(error ?? "Could not create a key.");
}

/** Create a docs key with `access` (null: the default docs key) and keep it for this tab. */
export async function createDocsKey(projectRef: string, access: string[] | null): Promise<DocsKey> {
  let res: Response;
  try {
    res = await fetch(
      dashboardLink(`/resources/docs/projects/${encodeURIComponent(projectRef)}/dev-keys`),
      {
        method: "POST",
        credentials: "include",
        // A form body keeps this a simple request, so there's no preflight.
        body: access ? new URLSearchParams({ access: access.join(",") }) : undefined,
      }
    );
  } catch {
    // Dashboard down, or an error response without CORS headers.
    throw new DocsKeyError("Couldn't reach the dashboard. Try again in a moment.");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<DocsKey> & { error?: string };
  if (!res.ok || !body.apiKey)
    throw keyCreationError(res.status, body.error, res.headers.get("Retry-After"));
  const key: DocsKey = {
    projectRef,
    env: "dev",
    name: body.name ?? "Docs key",
    apiKey: body.apiKey,
    apiUrl: body.apiUrl ?? "",
    access: body.access ?? null,
    scopes: body.scopes ?? null,
    created: new Date().toISOString(),
  };
  saveKeys([key, ...storedKeys()]);
  return key;
}

// Keys dropped this page load, so a field still holding one can be refilled with a new key.
const forgotten = new Set<string>();

/** Drop a key from this tab. It stays valid until revoked on the API keys page. */
export function forgetDocsKey(apiKey: string) {
  forgotten.add(apiKey);
  saveKeys(storedKeys().filter((k) => k.apiKey !== apiKey));
}

const OWNER = "trigger-docs:keys-owner";

/** Keys work in their creator's own dev environment: when a different reader signs in to this tab,
 * the previous reader's keys are dropped. */
export function keepKeysOf(userId: string) {
  let owner: string | null = null;
  try {
    owner = sessionStorage.getItem(OWNER);
    sessionStorage.setItem(OWNER, userId);
  } catch {}
  if (owner === userId) return;
  for (const k of storedKeys()) forgotten.add(k.apiKey);
  saveKeys([]);
}

/** Whether `value` is, or was, one of this tab's docs keys (not a key the reader typed). */
export function isDocsKey(value: string) {
  return forgotten.has(value) || storedKeys().some((k) => k.apiKey === value);
}

/**
 * What the playground's bearer field should hold, or undefined to leave it: the covering docs key,
 * or empty when there's none, so another project's or a revoked docs key never stays in it. A key
 * the reader typed is never touched.
 */
export function playgroundKey(current: unknown, key: DocsKey | null): string | undefined {
  if (current && !(typeof current === "string" && isDocsKey(current))) return undefined;
  const next = key?.apiKey ?? "";
  return (current ?? "") === next ? undefined : next;
}

/**
 * After an API response: a 401 for one of this tab's docs keys means it was revoked or has expired,
 * so it's dropped and the reader can create another. True when that happened.
 */
export function forgetRejectedKey(status: number, authorization: string | null): boolean {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (status !== 401 || !token || !storedKeys().some((k) => k.apiKey === token)) return false;
  forgetDocsKey(token);
  return true;
}

// The default docs key covers triggering tasks; samples without a specific API call need that.
export const DEFAULT_NEED = ["trigger:tasks"];

/** The tab's key for `project` that grants `needed` (or null). */
export function useCoveringKey(project: ReaderProject | null, needed: string[]): DocsKey | null {
  const keys = useDocsKeys();
  return project ? pickKey(keys, project.ref, needed) : null;
}

// Docs keys: the dev API keys the docs create for a signed-in reader, scoped to what a page needs.
import {
  type ApiKeyAccessOptions,
  type ApiKeyCapability,
  CUSTOM_API_KEY_PRESET_ID,
  isSavedApiKeyPresetId,
} from "@trigger.dev/plugins";
import { FULL_ACCESS_PRESET_ID } from "@trigger.dev/rbac";

/** The default docs key: triggers tasks and covers most of the API reference (runs, batches,
 * queues, waitpoints, sessions, errors, webhooks). */
const DOCS_KEY_PRESET_ID = "ENVIRONMENT_OPERATOR";

const ACCESS = /^(read|write|trigger|batchTrigger|admin):[a-zA-Z]+$/;

/** The `access` a docs key is requested with: `action:resource` scopes, comma-separated. Empty or
 * missing means the default docs key; undefined means invalid. */
export function parseRequestedAccess(raw: FormDataEntryValue | null): string[] | null | undefined {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const scopes = [...new Set(raw.split(",").map((s) => s.trim()))];
  if (scopes.length > 5 || !scopes.every((s) => ACCESS.test(s))) return undefined;
  return scopes;
}

// The docs match keys the same way: covers in apps/docs/lib/api-access.ts.
/** Whether `scopes` grant `scope` (same rules as the key matcher: exact, `<action>:all`, or `admin`). */
function scopesCover(scopes: readonly string[], scope: string) {
  const [action] = scope.split(":");
  return scopes.includes("admin") || scopes.includes(scope) || scopes.includes(`${action}:all`);
}

export type DocsKeyAccess = {
  presetId: string;
  capabilities?: Record<string, string>;
  /** What the key can do. */
  scopes: string[];
};

/** The narrowest key that grants `needed`: capabilities (a custom key) when the catalogue covers
 * every scope, else the smallest restricted preset that does. `needed` null is the default docs key.
 * null when only full access would do, or there is no preset catalogue (self-hosted): the docs never
 * create a full-access key, the reader makes one on the API keys page. */
export function docsKeyAccess(
  needed: string[] | null,
  options: ApiKeyAccessOptions | null
): DocsKeyAccess | null {
  if (!options) return null;
  const presets = options.presets.filter(
    (p) =>
      p.available &&
      !isSavedApiKeyPresetId(p.id) &&
      p.id !== FULL_ACCESS_PRESET_ID &&
      !p.scopes.includes("admin")
  );

  if (!needed) {
    const preset = presets.find((p) => p.id === DOCS_KEY_PRESET_ID);
    return preset ? { presetId: preset.id, scopes: preset.scopes } : null;
  }

  const custom = options.catalogue.available
    ? capabilitiesFor(needed, options.catalogue.capabilities)
    : undefined;
  if (custom) return { presetId: CUSTOM_API_KEY_PRESET_ID, ...custom };

  const preset = presets
    .filter(
      (p) => p.id !== CUSTOM_API_KEY_PRESET_ID && needed.every((s) => scopesCover(p.scopes, s))
    )
    .sort((a, b) => a.scopes.length - b.scopes.length)[0];
  return preset ? { presetId: preset.id, scopes: preset.scopes } : null;
}

function capabilitiesFor(needed: string[], catalogue: ApiKeyCapability[]) {
  // Per capability, the needed scopes it must grant.
  const wanted = new Map<ApiKeyCapability, string[]>();
  for (const scope of needed) {
    const options = catalogue
      .flatMap((capability) =>
        capability.levels
          .filter((level) => level.scopes.includes(scope))
          .map((level) => ({ capability, size: level.scopes.length }))
      )
      .sort((a, b) => a.size - b.size);
    if (options.length === 0) return undefined;
    const capability = (options.find((o) => wanted.has(o.capability)) ?? options[0]).capability;
    wanted.set(capability, [...(wanted.get(capability) ?? []), scope]);
  }

  const capabilities: Record<string, string> = {};
  const levelOf = (capability: ApiKeyCapability) =>
    capability.levels.find((l) => l.id === capabilities[capability.id]);
  // The smallest level of `capability` that grants `scopes` and keeps what's already chosen for it,
  // so a requirement or a later scope never takes away an earlier one.
  const choose = (capability: ApiKeyCapability, scopes: string[], levelIds?: string[]): boolean => {
    const keep = levelOf(capability)?.scopes ?? [];
    const level = capability.levels
      .filter((l) => !levelIds || levelIds.includes(l.id))
      .filter((l) => [...scopes, ...keep].every((s) => l.scopes.includes(s)))
      .sort((a, b) => a.scopes.length - b.scopes.length)[0];
    if (!level) return false;
    capabilities[capability.id] = level.id;
    // A level may need another capability (e.g. operating runs needs reading them).
    for (const req of level.requires ?? []) {
      if (req.levelIds.includes(capabilities[req.capabilityId] ?? "")) continue;
      const other = catalogue.find((c) => c.id === req.capabilityId);
      if (!other || !choose(other, [], req.levelIds)) return false;
    }
    return true;
  };
  for (const [capability, scopesNeeded] of wanted) {
    if (!choose(capability, scopesNeeded)) return undefined;
  }
  // What the key can do: the chosen levels' scopes, exactly as the policy will have them.
  const scopes = new Set(catalogue.flatMap((c) => levelOf(c)?.scopes ?? []));
  return { capabilities, scopes: [...scopes] };
}

// Docs keys are created per browser tab session as needed, so they expire instead of piling up.
const DOCS_KEY_LIFETIME_DAYS = 90;

/** When a docs key created `now` stops working, and the description that says so. */
export function docsKeyExpiry(now = new Date()) {
  const expiresAt = new Date(now.getTime() + DOCS_KEY_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
  return {
    expiresAt,
    description: `Created from the docs, expires ${expiresAt.toISOString().slice(0, 10)}`,
  };
}

const AREA_NAMES: Record<string, string> = { envvars: "env vars", batch: "batches" };

/** "Docs (2026-11-25)" for the default key, "Docs: env vars (2026-11-25)" for a scoped one. */
export function docsKeyName(needed: string[] | null, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  if (!needed) return `Docs (${date})`;
  const areas = [...new Set(needed.map((s) => s.split(":")[1]))].map((r) => AREA_NAMES[r] ?? r);
  return `Docs: ${areas.join(", ")} (${date})`;
}

import type { AuditLogEventQuery } from "@trigger.dev/plugins";

// The credentials the audit log can be filtered by. A credential is picked by a reference that
// names what its events record: `root:<environmentId>:<last4>` for an environment's root key, now
// or before a rotation; `key:<apiKeyId>`, `oat:<id>` and `pat:<id>` by row id. Events are matched
// by those fields, so a credential deleted since still matches, and nothing is looked up or hashed.
// The plugin scopes every query to the organization, so another organization's id matches nothing.

export type CredentialReference =
  | { kind: "root"; id: string; last4?: string }
  | { kind: "key" | "oat" | "pat"; id: string };

export function parseCredentialReference(value: string | undefined): CredentialReference | null {
  const root = value?.match(/^root:([A-Za-z0-9_-]{1,128})(?::([A-Za-z0-9]{4}))?$/);
  if (root) return { kind: "root", id: root[1]!, ...(root[2] ? { last4: root[2] } : {}) };
  const byId = value?.match(/^(key|oat|pat):([A-Za-z0-9_-]{1,128})$/);
  return byId ? { kind: byId[1] as "key" | "oat" | "pat", id: byId[2]! } : null;
}

/** The reference for an environment's root key, current or rotated, by its last 4. */
export function rootKeyReference(environmentId: string, apiKey: string): string {
  return `root:${environmentId}:${apiKey.slice(-4)}`;
}

/** What the reference's events recorded, for the plugin to match. */
export function credentialFilter(
  reference: CredentialReference
): NonNullable<AuditLogEventQuery["credential"]> {
  switch (reference.kind) {
    case "root":
      // A public JWT is recorded with the root key that signed it, so it counts as that key.
      // Without a last 4: every root key the environment has had.
      return { kinds: ["root_api_key", "public_jwt"], id: reference.id, last4: reference.last4 };
    case "key":
      return { kinds: ["additional_api_key"], id: reference.id };
    case "oat":
      return { kinds: ["oat"], id: reference.id };
    case "pat":
      return { kinds: ["pat"], id: reference.id };
  }
}

import { createHash, createHmac } from "node:crypto";
import { $replica } from "~/db.server";
import type { McpConfirmSpec, McpIdentity, McpPreviewRefusal, McpSubject } from "../gate/types";

export const PREVIEW_LIMIT = 64 * 1024;
const SENSITIVE_KEY = /secret|password|token|apikey|api_key|authorization/i;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
}

function hideSensitive(value: unknown, key: string, hidden = false): unknown {
  if (Array.isArray(value)) return value.map((item) => hideSensitive(item, key, hidden));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        hideSensitive(v, key, hidden || SENSITIVE_KEY.test(k)),
      ])
    );
  }
  if (hidden && (typeof value === "string" || typeof value === "number")) {
    const hash = createHmac("sha256", key).update(String(value)).digest("hex");
    return `[hidden hmac:${hash.slice(0, 8)}]`;
  }
  return value;
}

export function confirmationSubject(subject: McpSubject | null) {
  if (!subject) return null;
  const { organizationId, projectId, environmentId } = subject;
  return { organizationId, projectId, environmentId };
}

export function confirmationDigest(tool: string, args: unknown, subject: McpSubject | null) {
  return createHash("sha256")
    .update(canonicalJson({ tool, args: args ?? null, subject: confirmationSubject(subject) }))
    .digest("hex");
}

// Lazy so importing the gate doesn't parse env.
async function defaultFingerprintKey() {
  return (await import("~/env.server")).env.SESSION_SECRET;
}

export async function confirmationPreview(
  tool: string,
  spec: true,
  args: unknown,
  subject: McpSubject | null,
  fingerprintKey?: string
): Promise<{ preview: string; truncated: boolean }>;
export async function confirmationPreview(
  tool: string,
  spec: true | McpConfirmSpec,
  args: unknown,
  subject: McpSubject | null,
  fingerprintKey?: string
): Promise<{ preview: string; truncated: boolean } | McpPreviewRefusal>;
export async function confirmationPreview(
  tool: string,
  spec: true | McpConfirmSpec,
  args: unknown,
  subject: McpSubject | null,
  fingerprintKey?: string
): Promise<{ preview: string; truncated: boolean } | McpPreviewRefusal> {
  if (spec !== true) {
    const preview = await spec.preview(args, subject);
    if (typeof preview !== "string") return preview;
    if (preview.length > PREVIEW_LIMIT) {
      return {
        refuse: `This change is too large to confirm in full (${preview.length} characters, the limit is ${PREVIEW_LIMIT}). Split it into smaller calls.`,
      };
    }
    return { preview, truncated: false };
  }
  const preview = `${tool} ${canonicalJson(
    hideSensitive(args ?? {}, fingerprintKey ?? (await defaultFingerprintKey()))
  )}`;
  return preview.length > PREVIEW_LIMIT
    ? { preview: `${preview.slice(0, PREVIEW_LIMIT)}…`, truncated: true }
    : { preview, truncated: false };
}

export function confirmationTokenId(identity: McpIdentity): string {
  return identity.kind === "pat" ? identity.tokenId : identity.sourceTokenId;
}

export function confirmationClient(identity: McpIdentity): string {
  return identity.kind === "pat" ? "pat" : `uat:${identity.clientId ?? ""}`;
}

export async function describeMcpSubject(
  subject: Pick<McpSubject, "organizationId" | "projectId" | "environmentId"> | null
): Promise<string> {
  if (!subject) return "your account";
  const [organization, project, environment] = await Promise.all([
    $replica.organization.findFirst({
      where: { id: subject.organizationId },
      select: { title: true },
    }),
    subject.projectId
      ? $replica.project.findFirst({ where: { id: subject.projectId }, select: { name: true } })
      : null,
    subject.environmentId
      ? $replica.runtimeEnvironment.findFirst({
          where: { id: subject.environmentId },
          select: { slug: true, branchName: true },
        })
      : null,
  ]);
  return [organization?.title, project?.name, environment?.branchName ?? environment?.slug]
    .filter(Boolean)
    .join(" / ");
}

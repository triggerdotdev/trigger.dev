import { type OAuthClient, Prisma } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { hashToken } from "~/utils/tokens.server";
import {
  fetchMetadataDocumentText,
  metadataDocumentHost,
  type MetadataTransport,
} from "./cimdFetch.server";
import { oauthError, type OAuthError } from "./metadata.server";

/** Redirect targets a client may register. Hostnames match exactly; a missing hostname allows any. */
const REDIRECT_URI_ALLOW_LIST: ReadonlyArray<{
  protocol: string;
  hostname?: string;
  anyPort?: boolean;
}> = [
  { protocol: "https:", hostname: "claude.ai" },
  { protocol: "https:", hostname: "claude.com" },
  { protocol: "cursor:" },
  { protocol: "vscode:" },
  { protocol: "http:", hostname: "localhost", anyPort: true },
  { protocol: "http:", hostname: "127.0.0.1", anyPort: true },
  { protocol: "http:", hostname: "[::1]", anyPort: true },
];

const CIMD_CACHE_MS = 60 * 60 * 1000;

function isAllowedRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;

  return REDIRECT_URI_ALLOW_LIST.some(
    (entry) =>
      entry.protocol === url.protocol &&
      (entry.hostname === undefined ||
        (entry.hostname === url.hostname && (entry.anyPort || url.port === "")))
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function loopbackUrl(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password || url.hash) return null;
  return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
}

/** Exact match, or loopback URIs equal except for the port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (requested.includes("#")) return false;
  if (registered === requested) return true;
  const a = loopbackUrl(registered);
  const b = loopbackUrl(requested);
  return (
    !!a && !!b && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  );
}

/** The name shown for a client: a verified name first, then what the client says it is. */
export function clientDisplayName(client: Pick<OAuthClient, "displayName" | "selfReportedName">) {
  return client.displayName ?? client.selfReportedName ?? "MCP client";
}

const RegisterRequestSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().min(1).max(200).optional(),
  token_endpoint_auth_method: z.literal("none").default("none"),
  application_type: z.enum(["web", "native"]).optional(),
});

/** RFC 7591 dynamic registration. The same redirect URIs and name return the same client. */
export async function registerClient(
  body: unknown
): Promise<
  { ok: true; status: number; body: Record<string, unknown> } | { ok: false; body: OAuthError }
> {
  const parsed = RegisterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, body: oauthError("invalid_client_metadata", parsed.error.message) };
  }
  const { redirect_uris, client_name } = parsed.data;

  const rejected = redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
  if (rejected) {
    return {
      ok: false,
      body: oauthError("invalid_redirect_uri", `Redirect URI not allowed: ${rejected}`),
    };
  }

  const redirectUris = [...new Set(redirect_uris)].sort();
  const dedupeKey = hashToken(JSON.stringify([redirectUris, client_name ?? null]));

  const client = await prisma.oAuthClient
    .upsert({
      where: { dedupeKey },
      create: {
        kind: "DCR",
        clientId: nanoid(32),
        redirectUris,
        selfReportedName: client_name,
        dedupeKey,
      },
      update: { updatedAt: new Date() },
    })
    .catch(async (error) => {
      // A concurrent registration of the same client won the insert.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return prisma.oAuthClient.findFirstOrThrow({ where: { dedupeKey } });
      }
      throw error;
    });

  return {
    ok: true,
    status: 201,
    body: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      redirect_uris: client.redirectUris,
      ...(client.selfReportedName ? { client_name: client.selfReportedName } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  };
}

function cimdUrl(clientId: string): URL | null {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (url.pathname === "/" || !metadataDocumentHost(url)) return null;
  return url;
}

const ClientMetadataDocumentSchema = z.object({
  client_id: z.string(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().min(1).max(200).optional(),
});

async function fetchClientMetadataDocument(
  url: URL,
  transport?: MetadataTransport
): Promise<z.infer<typeof ClientMetadataDocumentSchema> | null> {
  try {
    const text = await fetchMetadataDocumentText(url, transport);
    if (text === null) return null;
    const parsed = ClientMetadataDocumentSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.client_id !== url.href) return null;
    if (!parsed.data.redirect_uris.every(isAllowedRedirectUri)) return null;
    return parsed.data;
  } catch (error) {
    logger.info("OAuth client metadata document fetch failed", {
      clientId: url.href,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Resolves a `client_id`: an https URL is a Client ID Metadata Document, fetched and cached;
 * anything else is a registered client.
 */
export async function resolveClient(
  clientId: string,
  transport?: MetadataTransport
): Promise<OAuthClient | null> {
  if (!clientId.startsWith("https://")) {
    const client = await prisma.oAuthClient.findFirst({ where: { clientId } });
    return client && client.kind !== "CIMD" ? client : null;
  }

  const url = cimdUrl(clientId);
  if (!url || url.href !== clientId) return null;

  const cached = await prisma.oAuthClient.findFirst({ where: { clientId } });
  if (cached?.kind === "PREREGISTERED") return cached;
  if (cached?.metadataExpiresAt && cached.metadataExpiresAt > new Date()) return cached;

  const document = await fetchClientMetadataDocument(url, transport);
  if (!document) return null;

  const data = {
    redirectUris: [...new Set(document.redirect_uris)],
    selfReportedName: document.client_name ?? null,
    metadataExpiresAt: new Date(Date.now() + CIMD_CACHE_MS),
  };
  return prisma.oAuthClient.upsert({
    where: { clientId },
    create: { kind: "CIMD", clientId, metadataUrl: clientId, ...data },
    update: data,
  });
}

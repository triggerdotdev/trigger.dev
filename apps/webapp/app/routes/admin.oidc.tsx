import { useFetcher, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { oidcSigningKeyService } from "~/services/oidc/instance.server";
import { OidcSigningKeyError } from "~/services/oidc/signingKeyService.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { requestUrl } from "~/utils/requestUrl.server";

const MutationSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("generate") }),
  z.object({ intent: z.literal("activate"), keyId: z.string().min(1) }),
  z.object({ intent: z.literal("disable") }),
]);

type MutationResult = { success?: boolean; error?: string };

export const loader = dashboardLoader({ authorization: { requireSuper: true } }, async () => {
  const status = await oidcSigningKeyService.getSigningStatus();
  return typedjson(
    { issuer: env.OIDC_ISSUER_URL, status, now: Date.now() },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
});

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request, user }) => {
    if (request.method !== "POST") {
      return typedjson(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } }
      );
    }
    // SameSite cookies alone do not protect against other origins on the same site.
    if (request.headers.get("Origin") !== requestUrl(request).origin) {
      return typedjson({ error: "Invalid request origin" }, { status: 403 });
    }
    if (!env.OIDC_ISSUER_URL) {
      return typedjson(
        { error: "Configure OIDC_ISSUER_URL before managing keys" },
        { status: 400 }
      );
    }

    const result = MutationSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!result.success) {
      return typedjson({ error: "Invalid key operation" }, { status: 400 });
    }

    try {
      switch (result.data.intent) {
        case "generate":
          await oidcSigningKeyService.generateStagedKey(user.id);
          break;
        case "activate":
          await oidcSigningKeyService.activateKey(result.data.keyId, user.id);
          break;
        case "disable":
          await oidcSigningKeyService.disableSigning(user.id);
          break;
      }
      return typedjson({ success: true });
    } catch (error) {
      if (error instanceof OidcSigningKeyError) {
        return typedjson({ error: error.message }, { status: 409 });
      }
      logger.error("OIDC signing key operation failed", {
        operation: result.data.intent,
        userId: user.id,
      });
      return typedjson(
        {
          error: "Key operation failed. Refresh the page and check the key status before retrying.",
        },
        { status: 409 }
      );
    }
  }
);

export default function AdminOidcRoute() {
  const { issuer, status, now } = useTypedLoaderData<typeof loader>();
  const generateFetcher = useFetcher<MutationResult>();
  const revalidator = useRevalidator();
  const keys = [
    ...(status.activeKey ? [status.activeKey] : []),
    ...(status.stagedKey ? [status.stagedKey] : []),
    ...status.retiredKeys,
  ];

  return (
    <main className="flex h-full flex-col gap-4 overflow-y-auto px-4 pb-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Paragraph className="text-text-bright">OIDC signing keys</Paragraph>
          <Paragraph variant="small">
            {issuer
              ? `Issuer: ${issuer}`
              : "OIDC is disabled. Configure OIDC_ISSUER_URL to enable it."}
          </Paragraph>
        </div>
        <div className="flex gap-2">
          <Button
            variant="tertiary/small"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state !== "idle"}
          >
            Refresh
          </Button>
          <generateFetcher.Form method="post">
            <input type="hidden" name="intent" value="generate" />
            <Button
              type="submit"
              variant="primary/small"
              disabled={!issuer || !!status.stagedKey || generateFetcher.state !== "idle"}
            >
              Generate key
            </Button>
          </generateFetcher.Form>
        </div>
      </div>

      {generateFetcher.data?.error && (
        <Callout variant="error">{generateFetcher.data.error}</Callout>
      )}
      <Callout variant={issuer && status.activeKey ? "info" : "warning"}>
        {!issuer
          ? "Token signing is disabled because OIDC_ISSUER_URL is not configured. Stored signing keys are unchanged."
          : status.activeKey
            ? "One key signs new tokens. Staged keys are published before activation, and retired public keys remain available until existing tokens expire."
            : "No active signing key. Token signing is disabled. Retained public keys can still verify existing tokens."}
      </Callout>
      {issuer && (
        <div className="flex gap-4 text-sm text-text-link">
          <a href={`${issuer}/.well-known/openid-configuration`} target="_blank" rel="noreferrer">
            Discovery document
          </a>
          <a href={`${issuer}/.well-known/jwks.json`} target="_blank" rel="noreferrer">
            Public JWKS
          </a>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Key ID</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Generated</TableHeaderCell>
            <TableHeaderCell>Activation ready</TableHeaderCell>
            <TableHeaderCell>Public until</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.length === 0 ? (
            <TableBlankRow colSpan={6}>
              <Paragraph>No signing keys configured</Paragraph>
            </TableBlankRow>
          ) : (
            keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>
                  <span className="font-mono text-xs">{key.kid}</span>
                </TableCell>
                <TableCell>{key.status}</TableCell>
                <TableCell>{key.createdAt.toLocaleString()}</TableCell>
                <TableCell>
                  {key.status === "STAGED" ? key.readyAt.toLocaleString() : "Not applicable"}
                </TableCell>
                <TableCell>
                  {key.publicUntil ? key.publicUntil.toLocaleString() : "While staged or active"}
                </TableCell>
                <TableCell>
                  {key.status === "STAGED" && (
                    <KeyMutation
                      intent="activate"
                      keyId={key.id}
                      disabled={!issuer || key.readyAt.getTime() > now}
                      label="Activate"
                      confirmation="Activate this key? It will sign new tokens. Any current signing key will be retired, but its public key will remain available for existing tokens."
                    />
                  )}
                  {key.status === "ACTIVE" && (
                    <KeyMutation
                      intent="disable"
                      disabled={!issuer}
                      label="Disable signing"
                      confirmation="Disable token signing? No new tokens can be signed until another key is activated. Existing tokens remain valid until expiry."
                    />
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <Paragraph variant="small">
        Keys use RS256. Private keys are encrypted and are never displayed. Refresh after the
        activation-ready time to enable activation.
      </Paragraph>
    </main>
  );
}

function KeyMutation({
  intent,
  keyId,
  disabled,
  label,
  confirmation,
}: {
  intent: "activate" | "disable";
  keyId?: string;
  disabled: boolean;
  label: string;
  confirmation: string;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<MutationResult>();
  const pending = fetcher.state !== "idle";

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={intent === "disable" ? "danger/small" : "secondary/small"}
            disabled={disabled || pending}
          >
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-3">
          <Paragraph variant="small">{confirmation}</Paragraph>
          <div className="flex justify-end gap-2">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <fetcher.Form method="post" onSubmit={() => setOpen(false)}>
              <input type="hidden" name="intent" value={intent} />
              {keyId && <input type="hidden" name="keyId" value={keyId} />}
              <Button
                type="submit"
                variant={intent === "disable" ? "danger/small" : "primary/small"}
                disabled={pending}
              >
                {label}
              </Button>
            </fetcher.Form>
          </div>
        </PopoverContent>
      </Popover>
      {fetcher.data?.error && (
        <Paragraph variant="small" className="text-error">
          {fetcher.data.error}
        </Paragraph>
      )}
    </div>
  );
}

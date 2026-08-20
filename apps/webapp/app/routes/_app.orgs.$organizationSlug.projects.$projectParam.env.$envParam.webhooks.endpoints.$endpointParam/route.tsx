import { BookOpenIcon, KeyIcon, SparklesIcon } from "@heroicons/react/24/solid";
import { useFetcher, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { randomBytes } from "node:crypto";
import { WebhookRoutingTarget, WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import type { WebhookValueSource } from "@trigger.dev/core/v3";
import { Suspense, useEffect, useState } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { PageBody } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { DeliveriesTable } from "~/components/webhookDeliveries/v1/DeliveriesTable";
import { EndpointStatusBadge } from "~/components/webhookEndpoints/v1/EndpointStatus";
import { $replica, prisma, webhookPrisma } from "~/db.server";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  WebhookDetailPresenter,
  type WebhookEndpointDetail,
} from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { requireUser } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3WebhookTaskPath } from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";

const EndpointParamSchema = EnvironmentParamSchema.extend({
  endpointParam: z.string(),
});

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const friendlyId = (data as { endpoint?: WebhookEndpointDetail } | undefined)?.endpoint
    ?.friendlyId;
  return [
    { title: friendlyId ? `${friendlyId} | Endpoints | Trigger.dev` : "Endpoint | Trigger.dev" },
  ];
};

// Shared gate + scope resolution for the loader and action.
async function requireWebhookAccess(request: Request, params: LoaderFunctionArgs["params"]) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam, endpointParam } =
    EndpointParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  if (!user.admin && !user.isImpersonating) {
    const org = await $replica.organization.findFirst({
      where: { id: project.organizationId },
      select: { featureFlags: true },
    });
    const enabled = await flag({
      key: FEATURE_FLAG.hasWebhooksAccess,
      defaultValue: false,
      overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
    });
    if (!enabled) throw new Response("Not found", { status: 404 });
  }

  return { user, project, environment, endpointParam };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { project, environment, endpointParam } = await requireWebhookAccess(request, params);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const presenter = new WebhookDetailPresenter($replica, clickhouse);

  const endpoint = await presenter.findEndpoint({
    environmentId: environment.id,
    endpointFriendlyId: endpointParam,
  });
  if (!endpoint) throw new Response("Endpoint not found", { status: 404 });

  const ingestUrl = webhookIngressUrl(endpoint.opaqueId);

  // Parse the tagged-union JSON columns for display (engine validates on write).
  const routing = WebhookRoutingTarget.safeParse(endpoint.routingTarget);
  const verifier = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const hasExplicitWindow = Boolean(periodParam || from || to);
  const period = periodParam ?? (hasExplicitWindow ? undefined : "7d");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction") ?? undefined;
  const direction = directionRaw ? DirectionSchema.parse(directionRaw) : undefined;

  const deliveriesList = presenter
    .listDeliveries({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      webhookEndpointId: endpoint.id,
      period,
      from,
      to,
      hasExplicitWindow,
      cursor,
      direction,
    })
    .catch(() => null);

  return typeddefer({
    endpoint,
    ingestUrl,
    routing: routing.success ? routing.data : null,
    verifier: verifier.success ? verifier.data : null,
    deliveriesList,
  });
};

const SetSecretSchema = z.object({
  intent: z.literal("set-secret"),
  secret: z.string().trim().min(1, "A signing secret is required"),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { project, environment, endpointParam } = await requireWebhookAccess(request, params);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const presenter = new WebhookDetailPresenter($replica, clickhouse);
  const endpoint = await presenter.findEndpoint({
    environmentId: environment.id,
    endpointFriendlyId: endpointParam,
  });
  if (!endpoint) throw new Response("Endpoint not found", { status: 404 });

  // Store the plaintext secret encrypted under the DATABASE SecretStore provider, in the exact
  // shape the engine's resolveSigningSecret reads ({ secret }). Key is namespaced by the endpoint's
  // internal id; point signingSecretKey at it so verification picks it up.
  const secretKey = `webhook:signing-secret:${endpoint.id}`;
  const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });

  const formData = await request.formData();
  const intent = formData.get("intent");

  // Generate (integrator-supplied secret): mint a strong secret, store it, and return it so the
  // UI can reveal it ONCE for the integrator to paste into their provider.
  if (intent === "generate-secret") {
    const verifier = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
    if (
      verifier.success &&
      "config" in verifier.data &&
      verifier.data.config.scheme === "asymmetric"
    ) {
      return {
        success: false as const,
        error: "Cannot generate a secret for an asymmetric endpoint; set its public key instead.",
      };
    }
    const secret = `whsec_${randomBytes(32).toString("hex")}`;
    await secretStore.setSecret(secretKey, { secret });
    await webhookPrisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { signingSecretKey: secretKey },
    });
    return { success: true as const, generatedSecret: secret };
  }

  // Set/Rotate (paste a provider-supplied secret).
  const submission = SetSecretSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return { success: false as const, error: submission.error.issues[0]?.message ?? "Invalid" };
  }
  await secretStore.setSecret(secretKey, { secret: submission.data.secret });
  await webhookPrisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { signingSecretKey: secretKey },
  });

  return { success: true as const };
};

export default function Page() {
  const { endpoint, ingestUrl, routing, verifier, deliveriesList } =
    useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const handlerPath = v3WebhookTaskPath(
    organization,
    project,
    environment,
    endpoint.handlerWebhookId
  );

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: handlerPath, text: endpoint.handlerWebhookId }}
          title={
            <span className="flex items-center gap-2">
              <WebhookIcon className="size-4.5 text-webhooks" />
              <span className="font-mono">{endpoint.friendlyId}</span>
              <EndpointStatusBadge status={endpoint.status} />
            </span>
          }
        />
        <PageAccessories>
          <LinkButton
            variant="docs/small"
            LeadingIcon={BookOpenIcon}
            to={docsPath("webhooks/overview")}
          >
            Webhooks docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="endpoint-deliveries" min="300px">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              <div className="flex h-10 items-center justify-between gap-2 border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                <Header2>Deliveries</Header2>
                <div className="flex items-center gap-2">
                  <TimeFilter defaultPeriod="7d" labelName="Deliveries" />
                  <Suspense fallback={null}>
                    <TypedAwait resolve={deliveriesList} errorElement={null}>
                      {(list) => (list ? <ListPagination list={list} /> : null)}
                    </TypedAwait>
                  </Suspense>
                </div>
              </div>
              <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                <Suspense fallback={<TableLoading />}>
                  <TypedAwait resolve={deliveriesList} errorElement={<TableLoading />}>
                    {(list) =>
                      list ? (
                        <DeliveriesTable
                          deliveries={list.deliveries}
                          hasFilters={list.hasFilters}
                          showTopBorder={false}
                          stickyHeader
                        />
                      ) : (
                        <TableLoading />
                      )
                    }
                  </TypedAwait>
                </Suspense>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle id="endpoint-detail-handle" />
          <ResizablePanel
            id="endpoint-detail"
            min="320px"
            default="420px"
            max="560px"
            isStaticAtRest
          >
            <EndpointSidebar
              endpoint={endpoint}
              ingestUrl={ingestUrl}
              routing={routing}
              verifier={verifier}
              handlerPath={handlerPath}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

function EndpointSidebar({
  endpoint,
  ingestUrl,
  routing,
  verifier,
  handlerPath,
}: {
  endpoint: WebhookEndpointDetail;
  ingestUrl: string;
  routing: LoaderData["routing"];
  verifier: LoaderData["verifier"];
  handlerPath: string;
}) {
  const metadataJson =
    endpoint.metadata != null && Object.keys(endpoint.metadata as object).length > 0
      ? JSON.stringify(endpoint.metadata, null, 2)
      : null;

  // Asymmetric endpoints store the provider's PUBLIC KEY, not a shared signing secret.
  const scheme = verifier && verifier.kind !== "bundle" ? verifier.config.scheme : undefined;
  const credentialNoun = scheme === "asymmetric" ? "public key" : "signing secret";
  const credentialLabel = scheme === "asymmetric" ? "Public key" : "Signing secret";

  // Generate-and-reveal makes sense when the integrator chooses the secret (and it's an HMAC
  // shared secret, not a provider public key). "provider" endpoints only paste.
  const canGenerate =
    scheme !== "asymmetric" &&
    (endpoint.secretProvisioning === "integrator" || endpoint.secretProvisioning === "either");

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5">
          <WebhookIcon className="size-4.5 shrink-0 text-webhooks" />
          <span className="truncate font-mono">{endpoint.friendlyId}</span>
        </Header2>
      </div>
      <div className="space-y-5 overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {/* Connect: the important new bit. Everything an integrator needs to point a provider here. */}
        <section className="space-y-2">
          <Header3>Connect</Header3>
          <Property.Table>
            <Property.Item>
              <Property.Label>Webhook URL</Property.Label>
              <Property.Value>
                <CopyableText value={ingestUrl} className="font-mono text-xs" />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>{credentialLabel}</Property.Label>
              <Property.Value>
                <div className="flex flex-col items-start gap-1.5">
                  {endpoint.hasSigningSecret ? (
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-success" />
                      <span>Set</span>
                    </span>
                  ) : (
                    <span className="text-warning">Not set, all deliveries are rejected</span>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {canGenerate ? (
                      <GenerateSecretDialog hasSigningSecret={endpoint.hasSigningSecret} />
                    ) : null}
                    <SetSecretDialog
                      hasSigningSecret={endpoint.hasSigningSecret}
                      credentialNoun={credentialNoun}
                      variant={canGenerate ? "tertiary/small" : "secondary/small"}
                    />
                  </div>
                </div>
              </Property.Value>
            </Property.Item>
          </Property.Table>
          <ProviderSetup verifier={verifier} source={endpoint.source} />
        </section>

        <section className="space-y-2">
          <Header3>Routing</Header3>
          <Property.Table>
            <Property.Item>
              <Property.Label>Target</Property.Label>
              <Property.Value>
                {routing?.type === "task" ? (
                  <TextLink to={handlerPath} className="font-mono text-xs">
                    {routing.taskId}
                  </TextLink>
                ) : routing?.type === "session" ? (
                  <span className="font-mono text-xs">session: {routing.taskIdentifier}</span>
                ) : (
                  <span className="text-text-dimmed">Unknown</span>
                )}
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </section>

        <section className="space-y-2">
          <Header3>Scope</Header3>
          <Property.Table>
            <Property.Item>
              <Property.Label>Source</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{endpoint.source}</span>
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Tenant</Property.Label>
              <Property.Value>
                {endpoint.isDefault ? (
                  <span className="text-text-dimmed">default</span>
                ) : (
                  <span className="font-mono text-sm">{endpoint.tenantId}</span>
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>External ref</Property.Label>
              <Property.Value>
                {endpoint.externalRef ? (
                  <span className="font-mono text-sm">{endpoint.externalRef}</span>
                ) : (
                  <span className="text-text-dimmed">None</span>
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Status</Property.Label>
              <Property.Value>
                <EndpointStatusBadge status={endpoint.status} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Created</Property.Label>
              <Property.Value>
                <DateTime date={endpoint.createdAt} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Updated</Property.Label>
              <Property.Value>
                <DateTime date={endpoint.updatedAt} />
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </section>

        {metadataJson ? (
          <section className="space-y-2">
            <Header3>Metadata</Header3>
            <CodeBlock code={metadataJson} language="json" showLineNumbers={false} maxLines={20} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ProviderSetup({ verifier, source }: { verifier: LoaderData["verifier"]; source: string }) {
  if (!verifier) return null;

  if (verifier.kind === "bundle") {
    return (
      <Paragraph variant="small" className="text-text-dimmed">
        This endpoint uses a custom verifier bundle.
      </Paragraph>
    );
  }

  const presetName = verifier.kind === "preset" ? verifier.preset : null;
  const config = verifier.config;

  return (
    <div className="space-y-2">
      <Paragraph variant="extra-small" className="uppercase text-text-dimmed">
        Provider setup
      </Paragraph>
      <Property.Table>
        <Property.Item>
          <Property.Label>Scheme</Property.Label>
          <Property.Value>
            <span className="font-mono text-sm">
              {presetName ? `${presetName} (${config.scheme})` : config.scheme}
            </span>
          </Property.Value>
        </Property.Item>
        {config.scheme === "hmac" || config.scheme === "asymmetric" ? (
          <>
            <Property.Item>
              <Property.Label>Signature header</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{config.signatureHeader}</span>
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Algorithm</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">
                  {config.algorithm} / {config.encoding}
                </span>
              </Property.Value>
            </Property.Item>
            {config.timestamp ? (
              <Property.Item>
                <Property.Label>Timestamp</Property.Label>
                <Property.Value>
                  <span className="font-mono text-xs">
                    {describeTimestampSource(config.timestamp.source)}
                  </span>
                </Property.Value>
              </Property.Item>
            ) : null}
            <Property.Item>
              <Property.Label>Signing string</Property.Label>
              <Property.Value>
                <span className="font-mono text-xs">
                  {config.signingString === "raw" ? "raw body" : config.signingString.template}
                </span>
              </Property.Value>
            </Property.Item>
            {config.scheme === "asymmetric" ? (
              <Property.Item>
                <Property.Label>Public key</Property.Label>
                <Property.Value>
                  <span className="font-mono text-sm">{config.publicKeyEncoding ?? "pem"}</span>
                </Property.Value>
              </Property.Item>
            ) : null}
          </>
        ) : config.scheme === "shared-secret" ? (
          <>
            <Property.Item>
              <Property.Label>Placement</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{config.placement}</span>
              </Property.Value>
            </Property.Item>
            {config.fieldName ? (
              <Property.Item>
                <Property.Label>Field name</Property.Label>
                <Property.Value>
                  <span className="font-mono text-sm">{config.fieldName}</span>
                </Property.Value>
              </Property.Item>
            ) : null}
          </>
        ) : (
          <>
            <Property.Item>
              <Property.Label>Placement</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{config.placement}</span>
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Param name</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{config.paramName}</span>
              </Property.Value>
            </Property.Item>
          </>
        )}
      </Property.Table>
      <Hint>
        {config.scheme === "asymmetric"
          ? `${source} signs with its private key; set its public key above.`
          : `Sign deliveries with the ${source} scheme above, using the signing secret.`}
      </Hint>
    </div>
  );
}

// Human-readable description of where the replay timestamp is read from.
function describeTimestampSource(source: WebhookValueSource): string {
  switch (source.from) {
    case "header":
      return `header ${source.name}`;
    case "signatureField":
      return `field "${source.field}" in signature header`;
    case "body":
      return `body ${source.path}`;
    case "url":
      return "request URL";
    case "constant":
      return "constant";
  }
}

function SetSecretDialog({
  hasSigningSecret,
  credentialNoun,
  variant = "secondary/small",
}: {
  hasSigningSecret: boolean;
  credentialNoun: string;
  variant?: "secondary/small" | "tertiary/small";
}) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  const verb = hasSigningSecret ? "Rotate" : "Set";
  const isPublicKey = credentialNoun === "public key";

  // Close on a successful save; the loader revalidates and the state flips to "Set".
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} LeadingIcon={KeyIcon}>
          {verb} {credentialNoun}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {verb} {credentialNoun}
        </DialogHeader>
        <fetcher.Form method="post" className="flex flex-col gap-3 pt-2">
          <input type="hidden" name="intent" value="set-secret" />
          <div className="flex flex-col gap-1">
            <Label htmlFor="secret">{credentialNoun}</Label>
            <Input
              id="secret"
              name="secret"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={isPublicKey ? "public key" : "whsec_…"}
            />
            <Hint>
              {isPublicKey
                ? "The provider's public key. Stored encrypted; deliveries are verified against it."
                : "Stored encrypted and never shown again. Deliveries are verified against this secret."}
            </Hint>
          </div>
          {fetcher.data && !fetcher.data.success ? (
            <Paragraph variant="small" className="text-error">
              {fetcher.data.error}
            </Paragraph>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="tertiary/small"
              onClick={() => setOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary/small" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save secret"}
            </Button>
          </div>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

// For integrator-supplied secrets (GitHub/GitLab/standard): mint a strong secret server-side,
// store it, and reveal it ONCE so the user can paste it into their provider.
function GenerateSecretDialog({ hasSigningSecret }: { hasSigningSecret: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  const generated =
    fetcher.data && "generatedSecret" in fetcher.data ? fetcher.data.generatedSecret : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary/small" LeadingIcon={SparklesIcon}>
          {hasSigningSecret ? "Regenerate secret" : "Generate secret"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {hasSigningSecret ? "Regenerate signing secret" : "Generate signing secret"}
        </DialogHeader>
        {generated ? (
          <div className="flex flex-col gap-3 pt-2">
            <Paragraph variant="small" className="text-warning">
              Copy this now. It won't be shown again.
            </Paragraph>
            <ClipboardField value={generated} variant="secondary/medium" />
            <Hint>Paste this into your provider's webhook signing-secret field.</Hint>
            <div className="flex justify-end">
              <Button type="button" variant="primary/small" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <fetcher.Form method="post" className="flex flex-col gap-3 pt-2">
            <input type="hidden" name="intent" value="generate-secret" />
            <Paragraph variant="small" className="text-text-dimmed">
              Trigger.dev generates a strong signing secret, stores it encrypted, and shows it once
              so you can paste it into your provider.
            </Paragraph>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="tertiary/small"
                onClick={() => setOpen(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary/small" disabled={isSubmitting}>
                {isSubmitting ? "Generating…" : "Generate secret"}
              </Button>
            </div>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TableLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

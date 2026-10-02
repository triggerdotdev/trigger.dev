import { BookOpenIcon, KeyIcon, SparklesIcon } from "@heroicons/react/24/solid";
import {
  useFetcher,
  useNavigation,
  useRevalidator,
  useSearchParams,
  type MetaFunction,
} from "@remix-run/react";
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
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { WebhookComposer } from "~/components/webhookConsole/WebhookComposer";
import { CopySetupPromptButton } from "~/components/webhookEndpoints/v1/CopySetupPromptButton";
import { EndpointSubscribersTable } from "~/components/webhookEndpoints/v1/EndpointSubscribers";
import {
  type EndpointWaiters,
  EndpointWaitersTable,
} from "~/components/webhookEndpoints/v1/EndpointWaitersTable";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { DeliveriesTable } from "~/components/webhookDeliveries/v1/DeliveriesTable";
import { useDeliveriesLiveReload } from "~/components/webhookDeliveries/v1/useDeliveriesLiveReload";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { EndpointStatusBadge } from "~/components/webhookEndpoints/v1/EndpointStatus";
import { prisma, $replica } from "~/db.server";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  WebhookDetailPresenter,
  type WebhookDeliveriesList,
  type WebhookEndpointDetail,
} from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { requireUser } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3WebhooksPath } from "~/utils/pathBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { parseFiniteInt } from "~/utils/searchParams";
import { webhookEngine, webhookVerifyTokenKey } from "~/v3/webhookEngine.server";
import {
  generateWebhookSigningSecret,
  storeWebhookSigningSecret,
} from "~/v3/webhookSigningSecret.server";
import { requireWebhooksAccess } from "~/v3/webhooksAccess.server";
import { rbac } from "~/services/rbac.server";

const EndpointParamSchema = EnvironmentParamSchema.extend({
  endpointParam: z.string(),
});

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const declaredId = (data as { endpoint?: WebhookEndpointDetail } | undefined)?.endpoint
    ?.declaredId;
  return [
    { title: declaredId ? `${declaredId} | Endpoints | Trigger.dev` : "Endpoint | Trigger.dev" },
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

  await requireWebhooksAccess(user, project.organizationId);

  return { user, project, environment, endpointParam };
}

const NO_WAITER_CANCEL = "You don't have permission to cancel waiters.";

/** A waiter is a waitpoint, so cancelling one needs write:waitpoints in this environment. */
async function canCancelWaiters(
  request: Request,
  {
    user,
    project,
    environment,
  }: Pick<Awaited<ReturnType<typeof requireWebhookAccess>>, "user" | "project" | "environment">
) {
  const auth = await rbac.authenticateSession(request, {
    userId: user.id,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  return auth.ok && auth.ability.can("write", { type: "waitpoints", envType: environment.type });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user, project, environment, endpointParam } = await requireWebhookAccess(request, params);

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
  const routing = (Array.isArray(endpoint.routingTargets) ? endpoint.routingTargets : []).flatMap(
    (target) => {
      const parsed = WebhookRoutingTarget.safeParse(target);
      return parsed.success ? [parsed.data] : [];
    }
  );
  const verifier = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);

  const getHandshake =
    verifier.success && "getHandshake" in verifier.data ? verifier.data.getHandshake : undefined;
  const hasVerifyToken = getHandshake
    ? Boolean(
        (
          await getSecretStore("DATABASE", { prismaClient: prisma }).getSecret(
            VerifyTokenSchema,
            webhookVerifyTokenKey(endpoint.id)
          )
        )?.token
      )
    : false;

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

  const waiters: Promise<EndpointWaiters | null> = webhookEngine
    .listWaiters({ endpointId: endpoint.id, limit: 50 })
    .catch(() => null);

  const composerEndpoints = presenter
    .listComposerEndpoints({ environmentId: environment.id, declaredId: endpoint.declaredId })
    .then((endpoints) => endpoints.filter((e) => e.friendlyId === endpoint.friendlyId))
    .catch(() => [] as Awaited<ReturnType<typeof presenter.listComposerEndpoints>>);

  return typeddefer({
    canCancelWaiters: await canCancelWaiters(request, { user, project, environment }),
    endpoint,
    ingestUrl,
    routing,
    verifier: verifier.success ? verifier.data : null,
    hasVerifyToken,
    deliveriesList,
    waiters,
    composerEndpoints,
  });
};

const SetSecretSchema = z.object({
  intent: z.literal("set-secret"),
  secret: z.string().trim().min(1, "A signing secret is required"),
});

const VerifyTokenSchema = z.object({ token: z.string() });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user, project, environment, endpointParam } = await requireWebhookAccess(request, params);

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

  const secretStore = getSecretStore("DATABASE", { prismaClient: prisma });

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "cancel-waiter") {
    if (!(await canCancelWaiters(request, { user, project, environment }))) {
      throwPermissionDenied(NO_WAITER_CANCEL);
    }
    const waiterId = formData.get("waiterId");
    if (typeof waiterId !== "string" || waiterId.length === 0) {
      return { success: false as const, error: "A waiter id is required" };
    }
    const result = await webhookEngine.cancelWaiter({
      environmentId: environment.id,
      waiterId,
      endpointId: endpoint.id,
    });
    return result.outcome === "cancelled"
      ? { success: true as const }
      : {
          success: false as const,
          error:
            result.outcome === "too_late"
              ? "Too late: a delivery already resumed this waiter"
              : "Waiter not found",
        };
  }

  // Generate (integrator-supplied secret): the UI reveals it ONCE for pasting into the provider.
  if (intent === "generate-secret") {
    const result = await generateWebhookSigningSecret(endpoint);
    return result.ok
      ? { success: true as const, generatedSecret: result.secret }
      : { success: false as const, error: result.error };
  }

  if (intent === "generate-verify-token") {
    const verifier = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
    const getHandshake =
      verifier.success && "getHandshake" in verifier.data ? verifier.data.getHandshake : undefined;
    if (!getHandshake) {
      return {
        success: false as const,
        error: "This endpoint's source does not verify its URL with a GET request.",
      };
    }
    const token = `whvt_${randomBytes(24).toString("hex")}`;
    await secretStore.setSecret(webhookVerifyTokenKey(endpoint.id), { token });
    return { success: true as const, generatedVerifyToken: token };
  }

  // Set/Rotate (paste a provider-supplied secret).
  const submission = SetSecretSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return { success: false as const, error: submission.error.issues[0]?.message ?? "Invalid" };
  }
  await storeWebhookSigningSecret(endpoint, submission.data.secret);

  return { success: true as const };
};

type EndpointTab = "deliveries" | "subscribers" | "waiters" | "test";

export default function Page() {
  const {
    endpoint,
    ingestUrl,
    routing,
    verifier,
    hasVerifyToken,
    deliveriesList,
    waiters,
    composerEndpoints,
    canCancelWaiters: canCancel,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<EndpointTab>(() => {
    const requested = searchParams.get("tab");
    return requested === "subscribers" || requested === "waiters" || requested === "test"
      ? requested
      : "deliveries";
  });

  const endpointsPath = v3WebhooksPath(organization, project, environment);

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: endpointsPath, text: "Endpoints" }}
          title={
            <span className="flex items-center gap-2">
              <WebhookIcon className="size-4.5 text-webhooks" />
              <span className="font-mono">{endpoint.declaredId}</span>
              {endpoint.isDefault ? null : (
                <span className="font-mono text-text-dimmed">{endpoint.tenantId}</span>
              )}
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
              <div className="flex h-10 items-end justify-between gap-2 border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                <TabContainer className="-mb-px">
                  {(
                    [
                      ["deliveries", "Deliveries"],
                      ["subscribers", "Subscribers"],
                      ["waiters", "Waiters"],
                      ["test", "Test"],
                    ] as const
                  ).map(([value, label]) => (
                    <TabButton
                      key={value}
                      isActive={tab === value}
                      layoutId="endpoint-hub-tabs"
                      onClick={() => setTab(value)}
                    >
                      {label}
                    </TabButton>
                  ))}
                </TabContainer>
                {tab === "deliveries" ? (
                  <div className="flex items-center gap-2 self-center">
                    <TimeFilter defaultPeriod="7d" labelName="Deliveries" />
                    <Suspense fallback={null}>
                      <TypedAwait resolve={deliveriesList} errorElement={null}>
                        {(list) => (list ? <ListPagination list={list} /> : null)}
                      </TypedAwait>
                    </Suspense>
                  </div>
                ) : null}
              </div>
              <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                {tab === "deliveries" ? (
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={deliveriesList} errorElement={<TableLoading />}>
                      {(list) =>
                        list ? (
                          <LiveDeliveriesTable list={list} webhookEndpointId={endpoint.id} />
                        ) : (
                          <TableLoading />
                        )
                      }
                    </TypedAwait>
                  </Suspense>
                ) : tab === "subscribers" ? (
                  <EndpointSubscribersTable targets={routing} />
                ) : tab === "waiters" ? (
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={waiters} errorElement={<TableLoading />}>
                      {(list) => <EndpointWaitersTable list={list} canCancel={canCancel} />}
                    </TypedAwait>
                  </Suspense>
                ) : (
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={composerEndpoints} errorElement={<TableLoading />}>
                      {(endpoints) =>
                        endpoints.length === 0 ? (
                          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-dimmed">
                            This endpoint can't be sent to from the dashboard.
                          </div>
                        ) : (
                          <WebhookComposer
                            endpoints={endpoints}
                            organizationSlug={organization.slug}
                            projectSlug={project.slug}
                            environmentSlug={environment.slug}
                            isDevEnvironment={environment.type === "DEVELOPMENT"}
                            environmentLabel={
                              environment.type.charAt(0) + environment.type.slice(1).toLowerCase()
                            }
                            redirectOnSuccess={false}
                          />
                        )
                      }
                    </TypedAwait>
                  </Suspense>
                )}
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
              hasVerifyToken={hasVerifyToken}
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
  hasVerifyToken,
}: {
  endpoint: WebhookEndpointDetail;
  ingestUrl: string;
  hasVerifyToken: boolean;
  routing: LoaderData["routing"];
  verifier: LoaderData["verifier"];
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
  const getHandshake =
    verifier && verifier.kind !== "bundle" ? (verifier.getHandshake ?? undefined) : undefined;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5">
          <WebhookIcon className="size-4.5 shrink-0 text-webhooks" />
          <span className="truncate font-mono">{endpoint.declaredId}</span>
        </Header2>
        <EndpointStatusBadge status={endpoint.status} />
      </div>
      <div className="space-y-5 overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {/* Connect: the important new bit. Everything an integrator needs to point a provider here. */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Header3>Connect</Header3>
            <CopySetupPromptButton
              endpointFriendlyId={endpoint.friendlyId}
              source={endpoint.source}
            />
          </div>
          <Property.Table>
            <Property.Item>
              <Property.Label>Webhook URL</Property.Label>
              <Property.Value>
                <CopyableText value={ingestUrl} className="font-mono text-xs" truncate />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>{credentialLabel}</Property.Label>
              <Property.Value>
                <div className="flex flex-col items-start gap-1.5">
                  {endpoint.hasSigningSecret ? (
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-success" />
                      <span>Ready</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-warning">
                      <span className="size-2 rounded-full bg-warning" />
                      <span>Needs {credentialNoun}, all deliveries are rejected</span>
                    </span>
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
            {getHandshake ? (
              <Property.Item>
                <Property.Label>Verify token</Property.Label>
                <Property.Value>
                  <div className="flex flex-col items-start gap-1.5">
                    {hasVerifyToken ? (
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full bg-success" />
                        <span>Set</span>
                      </span>
                    ) : (
                      <span className="text-warning">
                        Not set, the provider cannot verify this URL yet
                      </span>
                    )}
                    <GenerateVerifyTokenDialog hasVerifyToken={hasVerifyToken} />
                    <Hint>
                      The provider sends a GET with <code>{getHandshake.tokenParam}</code> when you
                      save the URL; it must carry this token.
                    </Hint>
                  </div>
                </Property.Value>
              </Property.Item>
            ) : null}
          </Property.Table>
          <ProviderSetup verifier={verifier} source={endpoint.source} />
        </section>

        <section className="space-y-2">
          <Header3>Scope</Header3>
          <Property.Table>
            <Property.Item>
              <Property.Label>ID</Property.Label>
              <Property.Value>
                <CopyableText value={endpoint.friendlyId} className="font-mono text-sm" />
              </Property.Value>
            </Property.Item>
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
                  <span className="text-text-dimmed">None</span>
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
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
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

/**
 * The GET verification token (Meta's `hub.verify_token`) is its own credential, separate from the
 * signing secret: minted server-side, stored encrypted, revealed once for the provider's Verify
 * Token field. Regenerating replaces it and the URL must be re-verified in the provider.
 */
function GenerateVerifyTokenDialog({ hasVerifyToken }: { hasVerifyToken: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const [dismissedToken, setDismissedToken] = useState<string | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  /**
   * The fetcher keeps its last action data for the life of the component, so closing the dialog
   * remembers which token was already revealed. A reopen then starts on the form again, and only a
   * newly generated token (which never repeats) is shown.
   */
  const latestToken =
    fetcher.data && "generatedVerifyToken" in fetcher.data
      ? fetcher.data.generatedVerifyToken
      : undefined;
  const generated =
    latestToken !== undefined && latestToken !== dismissedToken ? latestToken : undefined;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setDismissedToken(latestToken);
      setAttempted(false);
    }
  };
  const failure =
    attempted && fetcher.state === "idle" && fetcher.data && !fetcher.data.success
      ? fetcher.data
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="secondary/small" LeadingIcon={SparklesIcon}>
          {hasVerifyToken ? "Regenerate verify token" : "Generate verify token"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {hasVerifyToken ? "Regenerate verify token" : "Generate verify token"}
        </DialogHeader>
        {generated ? (
          <div className="flex flex-col gap-3 pt-2">
            <Paragraph variant="small" className="text-warning">
              Copy this now. It won't be shown again.
            </Paragraph>
            <ClipboardField value={generated} variant="secondary/medium" />
            <Hint>
              Paste this into the provider's Verify Token field when you save the webhook URL. It is
              separate from the signing secret.
            </Hint>
            <div className="flex justify-end">
              <Button type="button" variant="primary/small" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <fetcher.Form
            method="post"
            className="flex flex-col gap-3 pt-2"
            onSubmit={() => setAttempted(true)}
          >
            <input type="hidden" name="intent" value="generate-verify-token" />
            <Paragraph variant="small" className="text-text-dimmed">
              The provider verifies this URL with a GET request carrying a verify token. Trigger.dev
              generates the token, stores it encrypted, and shows it once so you can paste it into
              the provider.
              {hasVerifyToken
                ? " Regenerating replaces the current token; re-verify the URL in the provider afterwards."
                : ""}
            </Paragraph>
            {failure ? (
              <Paragraph variant="small" className="text-error">
                {failure.error}
              </Paragraph>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="tertiary/small"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary/small" disabled={isSubmitting}>
                {isSubmitting ? "Generating…" : "Generate verify token"}
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

/** The endpoint's deliveries, with live status updates and a pill for ones that arrived since load. */
function LiveDeliveriesTable({
  list,
  webhookEndpointId,
}: {
  list: WebhookDeliveriesList;
  webhookEndpointId: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const { visibleDeliveries, showNewDeliveriesBanner, newDeliveriesCount, dismissNewDeliveries } =
    useDeliveriesLiveReload({
      deliveries: list.deliveries,
      isLoading: navigation.state !== "idle",
      webhookEndpointId,
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
    });

  const onClickShowNewDeliveries = () => {
    dismissNewDeliveries();
    if (searchParams.has("cursor") || searchParams.has("direction")) {
      setSearchParams((prev) => {
        prev.delete("cursor");
        prev.delete("direction");
        return prev;
      });
      return;
    }
    revalidator.revalidate();
  };

  return (
    <>
      {showNewDeliveriesBanner ? (
        <div className="flex justify-end px-2 py-1.5">
          <span className="flex duration-150 animate-in fade-in-0">
            <Button
              variant="secondary/small"
              className="text-text-bright"
              onClick={onClickShowNewDeliveries}
              LeadingIcon={<PulsingDot className="h-2 w-2" />}
              tooltip="Refresh to see new deliveries"
              aria-label="New deliveries received. Refresh to see them."
            >
              {newDeliveriesCount >= 100
                ? "99+ new deliveries"
                : `${newDeliveriesCount} new ${
                    newDeliveriesCount === 1 ? "delivery" : "deliveries"
                  }`}
            </Button>
          </span>
        </div>
      ) : null}
      <DeliveriesTable
        deliveries={visibleDeliveries}
        hasFilters={list.hasFilters}
        showTopBorder={false}
        stickyHeader
      />
    </>
  );
}

import { PaperAirplaneIcon } from "@heroicons/react/20/solid";
import {
  KeyIcon,
  NoSymbolIcon,
  PlayIcon,
  SparklesIcon,
  TrashIcon,
} from "@heroicons/react/24/solid";
import { type ShouldRevalidateFunction, useFetcher } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { randomBytes } from "node:crypto";
import {
  WebhookPreviousSecretTtlSeconds,
  WebhookRoutingTarget,
  WebhookVerifierArtifact,
} from "@trigger.dev/core/v3";
import type { WebhookValueSource } from "@trigger.dev/core/v3";
import { useEffect, useState } from "react";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { DocsHeaderButton } from "~/components/DocsPanel";
import { CodeBlock } from "~/components/code/CodeBlock";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema } from "~/components/ListPagination";
import { Button } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  DetailHeader,
  DetailPage,
  DetailPageTitle,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
  type DetailTab,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import {
  DangerZone,
  DetailTabError,
  DetailTabLoading,
  DetailTableTab,
  SettingGroup,
  SettingRow,
  SkeletonBone,
} from "~/components/primitives/detail/DetailSections";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { WebhookComposer } from "~/components/webhookConsole/WebhookComposer";
import { CopySetupPromptButton } from "~/components/webhookEndpoints/v1/CopySetupPromptButton";
import { EndpointSubscribersTable } from "~/components/webhookEndpoints/v1/EndpointSubscribers";
import {
  type EndpointWaiters,
  EndpointWaitersTable,
} from "~/components/webhookEndpoints/v1/EndpointWaitersTable";
import { DeliveriesTab } from "~/components/webhookDeliveries/v1/DeliveriesTab";
import { parseDeliveryListFilters } from "~/components/webhookDeliveries/v1/deliveryListFilters";
import { EndpointStatusBadge } from "~/components/webhookEndpoints/v1/EndpointStatus";
import { prisma, $replica } from "~/db.server";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import {
  type DeliveryActivity,
  WebhookDetailPresenter,
  type WebhookEndpointDetail,
} from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { requireUser } from "~/services/session.server";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import { pageMeta } from "~/utils/pageTitle";
import { EnvironmentParamSchema, v3WebhooksPath } from "~/utils/pathBuilder";
import { throwPermissionDenied } from "~/utils/permissionDenied";
import { parseFiniteInt } from "~/utils/searchParams";
import { webhookEngine, webhookVerifyTokenKey } from "~/v3/webhookEngine.server";
import { setWebhookEndpointEnabled } from "~/v3/webhookEndpointStatus.server";
import {
  capturedWebhookSigningSecret,
  clearWebhookSigningSecret,
  generateWebhookSigningSecret,
  hideCapturedWebhookSigningSecret,
  storeWebhookSigningSecret,
} from "~/v3/webhookSigningSecret.server";
import { requireWebhooksAccess } from "~/v3/webhooksAccess.server";
import { rbac } from "~/services/rbac.server";

const EndpointParamSchema = EnvironmentParamSchema.extend({
  endpointParam: z.string(),
});

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.endpoint?.declaredId ?? params.endpointParam ?? "Endpoint",
  "Endpoints",
]);

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

const NO_WEBHOOKS_WRITE = "You don't have permission to change webhooks in this environment.";

async function canWriteWebhooks(
  request: Request,
  scope: {
    userId: string;
    organizationId: string;
    projectId: string;
    environmentType: RuntimeEnvironmentType;
  }
): Promise<boolean> {
  const auth = await rbac.authenticateSession(request, {
    userId: scope.userId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
  });
  return auth.ok && auth.ability.can("write", { type: "webhooks", envType: scope.environmentType });
}

const EMPTY_ACTIVITY: DeliveryActivity = {
  data: [],
  statuses: [],
  totals: {},
  lastDeliveryAt: null,
};

/**
 * An endpoint on the detail template. Postgres (the endpoint, its secrets' state, permissions) is
 * awaited; ClickHouse (deliveries and their chart), the waiters and the test composer's endpoints
 * are deferred, so every tab's data arrives with the page and switching tabs makes no request.
 */
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
  const deliveriesTabOpen = (url.searchParams.get("tab") ?? "deliveries") === "deliveries";
  const periodParam = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const hasExplicitWindow = Boolean(periodParam || from || to);
  const period = periodParam ?? (hasExplicitWindow ? undefined : "7d");
  const time = timeFilterFromTo({ period: periodParam, from, to, defaultPeriod: "7d" });
  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  };

  const deliveriesList = presenter
    .listDeliveries({
      ...scope,
      webhookEndpointIds: [endpoint.id],
      period,
      from,
      to,
      hasExplicitWindow,
      filters: parseDeliveryListFilters(url.searchParams),
      cursor: deliveriesTabOpen ? (url.searchParams.get("cursor") ?? undefined) : undefined,
      direction: DirectionSchema.catch("forward").parse(
        url.searchParams.get("direction") ?? undefined
      ),
    })
    .catch(() => null);

  const deliveryActivity = presenter
    .getDeliveryActivity({
      ...scope,
      webhookEndpointIds: [endpoint.id],
      from: time.from,
      to: time.to,
    })
    .catch(() => EMPTY_ACTIVITY);

  const waiters: Promise<EndpointWaiters | null> = webhookEngine
    .listWaiters({ endpointId: endpoint.id, limit: 50 })
    .catch(() => null);

  const composerEndpoints = presenter
    .listComposerEndpoints({ environmentId: environment.id, declaredId: endpoint.declaredId })
    .then((endpoints) => endpoints.filter((e) => e.friendlyId === endpoint.friendlyId))
    .catch(() => [] as Awaited<ReturnType<typeof presenter.listComposerEndpoints>>);

  const canWrite = await canWriteWebhooks(request, {
    userId: user.id,
    organizationId: project.organizationId,
    projectId: project.id,
    environmentType: environment.type,
  });

  // A secret the provider sent itself (Notion's verification token) has to be pasted back into the
  // provider, so it is shown to users who can change the endpoint until they hide it.
  const secretCapture =
    verifier.success && "secretCapture" in verifier.data ? verifier.data.secretCapture : undefined;
  const capturedSecret =
    canWrite && secretCapture && endpoint.hasSigningSecret
      ? await capturedWebhookSigningSecret(endpoint.id)
      : null;

  return typeddefer({
    canCancelWaiters: await canCancelWaiters(request, { user, project, environment }),
    canWrite,
    capturedSecret,
    endpoint,
    ingestUrl,
    routing,
    verifier: verifier.success ? verifier.data : null,
    hasVerifyToken,
    deliveriesList,
    deliveryActivity,
    waiters,
    composerEndpoints,
  });
};

/** Every tab's data is already loaded: switching tabs doesn't run the loader again. */
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

const PreviousSecretTtlFormField = z.object({
  previousSecretTtlSeconds: z.coerce.number().pipe(WebhookPreviousSecretTtlSeconds).optional(),
});

const SetSecretSchema = PreviousSecretTtlFormField.extend({
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
      organizationId: environment.organizationId,
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

  const canWrite = await canWriteWebhooks(request, {
    userId: user.id,
    organizationId: project.organizationId,
    projectId: project.id,
    environmentType: environment.type,
  });
  if (!canWrite) throwPermissionDenied(NO_WEBHOOKS_WRITE);

  if (intent === "disable-endpoint" || intent === "enable-endpoint") {
    const enabled = intent === "enable-endpoint";
    const changed = await setWebhookEndpointEnabled(endpoint.id, enabled);
    if (!changed) {
      return jsonWithErrorMessage(
        { success: false as const },
        request,
        `${endpoint.declaredId} is being deleted`
      );
    }
    return jsonWithSuccessMessage(
      { success: true as const },
      request,
      `${endpoint.declaredId} ${enabled ? "enabled" : "disabled"}`
    );
  }

  // Generate (integrator-supplied secret): the UI reveals it ONCE for pasting into the provider.
  if (intent === "generate-secret") {
    const ttl = PreviousSecretTtlFormField.safeParse(Object.fromEntries(formData));
    if (!ttl.success) {
      return { success: false as const, error: ttl.error.issues[0]?.message ?? "Invalid" };
    }
    const result = await generateWebhookSigningSecret(endpoint, ttl.data);
    return result.ok
      ? {
          success: true as const,
          generatedSecret: result.secret,
          previousSecretExpiresAt: result.previousSecretExpiresAt,
        }
      : { success: false as const, error: result.error };
  }

  if (intent === "clear-secret") {
    await clearWebhookSigningSecret(endpoint.id);
    return { success: true as const };
  }

  if (intent === "hide-captured-secret") {
    await hideCapturedWebhookSigningSecret(endpoint.id);
    return { success: true as const };
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
  await storeWebhookSigningSecret(endpoint, submission.data.secret, {
    previousSecretTtlSeconds: submission.data.previousSecretTtlSeconds,
  });

  return { success: true as const };
};

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

/** The page's tabs, in order; the first opens by default. */
const ENDPOINT_TABS = ["deliveries", "subscribers", "waiters", "test", "settings"] as const;
type EndpointTab = (typeof ENDPOINT_TABS)[number];

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const { endpoint, routing } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [tab, setTab, isPending] = useDetailTab<EndpointTab>(ENDPOINT_TABS);

  const tabs: DetailTab<EndpointTab>[] = [
    { id: "deliveries", label: "Deliveries" },
    { id: "subscribers", label: "Subscribers", count: String(routing.length) },
    { id: "waiters", label: "Waiters" },
    { id: "test", label: "Test" },
    { id: "settings", label: "Settings" },
  ];

  const sendTest = (variant: "primary/small" | "secondary/small") => (
    <Button
      variant={variant}
      LeadingIcon={PaperAirplaneIcon}
      onClick={() => setTab("test", { cursor: undefined, direction: undefined })}
    >
      Send test event
    </Button>
  );

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={endpointTitle(endpoint)}
          backButton={{
            to: v3WebhooksPath(organization, project, environment),
            text: "Endpoints",
          }}
        />
        <PageAccessories>
          <DocsHeaderButton path="webhooks/overview">Webhooks docs</DocsHeaderButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <DetailPage
          id="webhook-endpoint"
          header={<EndpointHeader data={data} primaryAction={sendTest("primary/small")} />}
          tabs={
            <DetailTabs
              tabs={tabs}
              activeTab={tab}
              onTabChange={(next) => setTab(next, { cursor: undefined, direction: undefined })}
              layoutId="endpoint-tab"
            />
          }
          rail={<EndpointRail data={data} />}
        >
          {tab === "deliveries" ? (
            <DeliveriesTab
              deliveriesList={data.deliveriesList}
              activity={data.deliveryActivity}
              webhookEndpointIds={[endpoint.id]}
              isPending={isPending}
              emptyAction={sendTest("secondary/small")}
            />
          ) : tab === "subscribers" ? (
            <DetailTableTab>
              <EndpointSubscribersTable targets={routing} />
            </DetailTableTab>
          ) : tab === "waiters" ? (
            <WaitersTab data={data} />
          ) : tab === "test" ? (
            <TestTab data={data} />
          ) : (
            <SettingsTab data={data} />
          )}
        </DetailPage>
      </PageBody>
    </PageContainer>
  );
}

function endpointTitle(
  endpoint: Pick<WebhookEndpointDetail, "declaredId" | "isDefault" | "tenantId">
) {
  return endpoint.isDefault ? endpoint.declaredId : `${endpoint.declaredId} · ${endpoint.tenantId}`;
}

// ---------- Header ----------

function EndpointHeader({
  data,
  primaryAction,
}: {
  data: LoaderData;
  primaryAction: React.ReactNode;
}) {
  const { endpoint } = data;
  return (
    <DetailHeader
      icon={WebhookIcon}
      iconClassName="text-webhooks"
      title={endpointTitle(endpoint)}
      mono
      friendlyId={endpoint.friendlyId}
      status={<EndpointStatusBadge status={endpoint.status} />}
      meta={[
        <span key="source">
          Source <span className="font-mono">{endpoint.source}</span>
        </span>,
        endpoint.isDefault ? "Default tenant" : `Tenant ${endpoint.tenantId}`,
        <LastDelivery key="last" activity={data.deliveryActivity} />,
      ]}
      secondaryActions={
        <CopySetupPromptButton
          endpointFriendlyId={endpoint.friendlyId}
          source={endpoint.source}
          variant="secondary/small"
        />
      }
      primaryAction={primaryAction}
    />
  );
}

function LastDelivery({ activity }: { activity: Promise<DeliveryActivity> }) {
  return (
    <DeferredContent
      resolve={activity}
      fallback={<SkeletonBone className="h-3 w-24" />}
      errorElement={null}
    >
      {(result) =>
        result.lastDeliveryAt ? (
          <span>
            Last delivery <RelativeDateTime date={result.lastDeliveryAt} capitalize={false} />
          </span>
        ) : (
          <span>No deliveries in this period</span>
        )
      }
    </DeferredContent>
  );
}

// ---------- Tabs ----------

function WaitersTab({ data }: { data: LoaderData }) {
  const loading = (
    <DetailTableTab>
      <DetailTabLoading
        columns={[
          { label: "Waiter" },
          { label: "Match" },
          { label: "Filter" },
          { label: "Expires" },
        ]}
        rows={4}
      />
    </DetailTableTab>
  );
  return (
    <DeferredContent
      resolve={data.waiters}
      fallback={loading}
      errorElement={
        <DetailTabError
          title="Couldn't load waiters"
          cause="The runs waiting on this endpoint didn't load. Try again in a moment."
        />
      }
    >
      {(list) => (
        <DetailTableTab>
          <EndpointWaitersTable list={list} canCancel={data.canCancelWaiters} />
        </DetailTableTab>
      )}
    </DeferredContent>
  );
}

function TestTab({ data }: { data: LoaderData }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return (
    <DeferredContent
      resolve={data.composerEndpoints}
      fallback={<DetailTabLoading columns={[{ label: "" }]} rows={6} />}
      errorElement={
        <DetailTabError title="Couldn't load the test console" cause="Try again in a moment." />
      }
    >
      {(endpoints) =>
        endpoints.length === 0 ? (
          <DetailTabError
            title="Can't send to this endpoint from the dashboard"
            cause="Its source signs deliveries in a way the test console can't reproduce."
          />
        ) : (
          <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
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
          </div>
        )
      }
    </DeferredContent>
  );
}

/** What it takes to connect the provider, and the controls that change it. */
function SettingsTab({ data }: { data: LoaderData }) {
  const { endpoint, verifier, canWrite, hasVerifyToken, capturedSecret, ingestUrl } = data;
  const disabledReason = canWrite
    ? undefined
    : "You don't have permission to change this endpoint.";
  const { scheme, credentialNoun, credentialLabel, canGenerate, getHandshake, secretCapture } =
    describeVerifier(data);

  return (
    <div className="h-full overflow-y-auto px-4 pb-8 pt-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
        <SettingGroup title="Connect">
          <SettingRow
            title="Webhook URL"
            description={`Paste this into ${endpoint.source} as the delivery URL`}
            value={<CopyableText value={ingestUrl} className="font-mono text-xs" truncate />}
          />
          <SettingRow
            title={credentialLabel}
            description={
              scheme === "asymmetric"
                ? "The provider's public key; deliveries are verified against it"
                : "Deliveries are verified against it, and rejected without one"
            }
            value={<SigningSecretState data={data} />}
            control={
              <div className="flex items-center gap-2">
                <SetSecretDialog
                  hasSigningSecret={endpoint.hasSigningSecret}
                  credentialNoun={credentialNoun}
                  variant={canGenerate ? "tertiary/small" : "secondary/small"}
                  disabledReason={disabledReason}
                />
                {canGenerate ? (
                  <GenerateSecretDialog
                    hasSigningSecret={endpoint.hasSigningSecret}
                    disabledReason={disabledReason}
                  />
                ) : null}
              </div>
            }
          />
          {capturedSecret ? (
            <div className="border-b border-grid-dimmed py-2.5">
              <CapturedSecret secret={capturedSecret.secret} />
            </div>
          ) : null}
          {getHandshake ? (
            <SettingRow
              title="Verify token"
              description={`The provider's GET carries it in ${getHandshake.tokenParam} when you save the URL`}
              value={
                hasVerifyToken ? (
                  <StateDot tone="ok">Set</StateDot>
                ) : (
                  <StateDot tone="warn">Not set</StateDot>
                )
              }
              control={
                <GenerateVerifyTokenDialog
                  hasVerifyToken={hasVerifyToken}
                  disabledReason={disabledReason}
                />
              }
            />
          ) : null}
        </SettingGroup>
        {verifier ? (
          <SettingGroup title="Verification">
            <div className="max-w-[47.5rem] py-2.5">
              <ProviderSetup verifier={verifier} source={endpoint.source} />
            </div>
          </SettingGroup>
        ) : null}
        <DangerZone>
          {endpoint.hasSigningSecret ? (
            <SettingRow
              title={`Clear ${credentialNoun}`}
              description="Every delivery is rejected until a new one is set"
              control={
                <ClearSecretDialog
                  credentialNoun={credentialNoun}
                  capturesSecret={secretCapture !== undefined}
                  disabledReason={disabledReason}
                />
              }
            />
          ) : null}
          <EnableEndpointRow endpoint={endpoint} disabledReason={disabledReason} />
        </DangerZone>
      </div>
    </div>
  );
}

function EnableEndpointRow({
  endpoint,
  disabledReason,
}: {
  endpoint: WebhookEndpointDetail;
  disabledReason?: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  const active = endpoint.status === "ACTIVE";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  if (!active) {
    return (
      <SettingRow
        title="Enable endpoint"
        description="It's disabled: the provider's deliveries get a 404 and aren't recorded"
        value={<EndpointStatusBadge status={endpoint.status} />}
        control={
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="enable-endpoint" />
            <Button
              type="submit"
              variant="secondary/small"
              LeadingIcon={PlayIcon}
              disabled={disabledReason !== undefined || isSubmitting}
              tooltip={disabledReason}
            >
              {isSubmitting ? "Enabling…" : "Enable"}
            </Button>
          </fetcher.Form>
        }
      />
    );
  }

  return (
    <SettingRow
      title="Disable endpoint"
      description="Stops accepting deliveries until it's enabled again"
      control={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              variant="danger/small"
              LeadingIcon={NoSymbolIcon}
              disabled={disabledReason !== undefined}
              tooltip={disabledReason}
            >
              Disable…
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>Disable {endpoint.declaredId}</DialogHeader>
            <fetcher.Form method="post" className="flex flex-col gap-3 pt-2">
              <input type="hidden" name="intent" value="disable-endpoint" />
              <Paragraph variant="small" className="text-text-dimmed">
                The webhook URL answers 404 until you enable it again, so the provider's deliveries
                aren't recorded and nothing runs. Most providers retry for a while, then give up.
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
                <Button type="submit" variant="danger/small" disabled={isSubmitting}>
                  {isSubmitting ? "Disabling…" : "Disable endpoint"}
                </Button>
              </div>
            </fetcher.Form>
          </DialogContent>
        </Dialog>
      }
    />
  );
}

// ---------- Rail ----------

function describeVerifier({ verifier, endpoint }: Pick<LoaderData, "verifier" | "endpoint">) {
  // Asymmetric endpoints store the provider's PUBLIC KEY, not a shared signing secret.
  const scheme = verifier && verifier.kind !== "bundle" ? verifier.config.scheme : undefined;
  return {
    scheme,
    credentialNoun: scheme === "asymmetric" ? "public key" : "signing secret",
    credentialLabel: scheme === "asymmetric" ? "Public key" : "Signing secret",
    // Generate-and-reveal makes sense when the integrator chooses the secret (and it's an HMAC
    // shared secret, not a provider public key). "provider" endpoints only paste.
    canGenerate:
      scheme !== "asymmetric" &&
      (endpoint.secretProvisioning === "integrator" || endpoint.secretProvisioning === "either"),
    getHandshake:
      verifier && verifier.kind !== "bundle" ? (verifier.getHandshake ?? undefined) : undefined,
    secretCapture:
      verifier && verifier.kind !== "bundle" ? (verifier.secretCapture ?? undefined) : undefined,
  };
}

function StateDot({ tone, children }: { tone: "ok" | "warn"; children: React.ReactNode }) {
  return (
    <span
      className={
        tone === "ok" ? "flex items-center gap-1.5" : "flex items-center gap-1.5 text-warning"
      }
    >
      <span
        className={
          tone === "ok" ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-warning"
        }
      />
      <span>{children}</span>
    </span>
  );
}

/** Ready, or what's missing, with the consequence in the tooltip. */
function SigningSecretState({ data }: { data: LoaderData }) {
  const { credentialNoun, secretCapture } = describeVerifier(data);
  if (data.endpoint.hasSigningSecret) return <StateDot tone="ok">Ready</StateDot>;
  return (
    <SimpleTooltip
      content={
        secretCapture
          ? "The provider sends its signing secret to this URL when you create the subscription; it's stored automatically."
          : `Every delivery is rejected until the ${credentialNoun} is set on the Settings tab.`
      }
      button={
        <StateDot tone="warn">
          {secretCapture ? "Waiting for the provider" : `Needs ${credentialNoun}`}
        </StateDot>
      }
    />
  );
}

function EndpointRail({ data }: { data: LoaderData }) {
  const { endpoint, ingestUrl, verifier, hasVerifyToken } = data;
  const { credentialLabel, getHandshake } = describeVerifier(data);
  const metadataJson =
    endpoint.metadata != null && Object.keys(endpoint.metadata as object).length > 0
      ? JSON.stringify(endpoint.metadata, null, 2)
      : null;

  return (
    <PropertyRail>
      <PropertyGroup title="Details">
        <PropertyPair>
          <DetailProperty label="ID">
            <CopyableText value={endpoint.friendlyId} className="font-mono text-xs" truncate />
          </DetailProperty>
          <DetailProperty label="Status">
            <EndpointStatusBadge status={endpoint.status} />
          </DetailProperty>
          <DetailProperty label="Source">
            <span className="font-mono text-xs">{endpoint.source}</span>
          </DetailProperty>
          <DetailProperty label="Tenant">
            {endpoint.isDefault ? (
              <span className="text-text-dimmed">None</span>
            ) : (
              <span className="font-mono text-xs">{endpoint.tenantId}</span>
            )}
          </DetailProperty>
          <DetailProperty label="External ref">
            {endpoint.externalRef ? (
              <span className="font-mono text-xs">{endpoint.externalRef}</span>
            ) : (
              <span className="text-text-dimmed">None</span>
            )}
          </DetailProperty>
          <DetailProperty label="Created">
            <DateTime date={endpoint.createdAt} />
          </DetailProperty>
          <DetailProperty label="Updated">
            <DateTime date={endpoint.updatedAt} />
          </DetailProperty>
        </PropertyPair>
      </PropertyGroup>
      <PropertyGroup title="Connect">
        <DetailProperty label="Webhook URL">
          <CopyableText value={ingestUrl} className="min-w-0 font-mono text-xs" truncate />
        </DetailProperty>
        <DetailProperty label={credentialLabel}>
          <SigningSecretState data={data} />
        </DetailProperty>
        {getHandshake ? (
          <DetailProperty label="Verify token">
            {hasVerifyToken ? (
              <StateDot tone="ok">Set</StateDot>
            ) : (
              <SimpleTooltip
                content="The provider can't verify this URL until a verify token is set on the Settings tab."
                button={<StateDot tone="warn">Not set</StateDot>}
              />
            )}
          </DetailProperty>
        ) : null}
      </PropertyGroup>
      {verifier && verifier.kind !== "bundle" ? (
        <PropertyGroup title="Signature">
          <SignatureProperties verifier={verifier} />
        </PropertyGroup>
      ) : null}
      {metadataJson ? (
        <PropertyGroup title="Metadata">
          <CodeBlock code={metadataJson} language="json" showLineNumbers={false} maxLines={20} />
        </PropertyGroup>
      ) : null}
    </PropertyRail>
  );
}

/** How the provider signs, in brief: the scheme and where the signature travels. */
function SignatureProperties({
  verifier,
}: {
  verifier: Exclude<NonNullable<LoaderData["verifier"]>, { kind: "bundle" }>;
}) {
  const presetName = verifier.kind === "preset" ? verifier.preset : null;
  const config = verifier.config;
  return (
    <PropertyPair>
      <DetailProperty label="Scheme">
        <span className="font-mono text-xs">
          {presetName ? `${presetName} (${config.scheme})` : config.scheme}
        </span>
      </DetailProperty>
      {config.scheme === "hmac" || config.scheme === "asymmetric" ? (
        <>
          <DetailProperty label="Header">
            <span className="truncate font-mono text-xs">{config.signatureHeader}</span>
          </DetailProperty>
          <DetailProperty label="Algorithm">
            <span className="font-mono text-xs">
              {config.algorithm} / {config.encoding}
            </span>
          </DetailProperty>
        </>
      ) : (
        <DetailProperty label="Placement">
          <span className="font-mono text-xs">{config.placement}</span>
        </DetailProperty>
      )}
    </PropertyPair>
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

  const rows: { label: string; value: string }[] = [
    { label: "Scheme", value: presetName ? `${presetName} (${config.scheme})` : config.scheme },
  ];
  if (config.scheme === "hmac" || config.scheme === "asymmetric") {
    rows.push({
      label: "Signature header",
      value: [
        config.signatureHeader,
        ...(config.scheme === "hmac" ? (config.additionalSignatureHeaders ?? []) : []),
      ].join(", "),
    });
    rows.push({ label: "Algorithm", value: `${config.algorithm} / ${config.encoding}` });
    if (config.timestamp) {
      rows.push({ label: "Timestamp", value: describeTimestampSource(config.timestamp.source) });
    }
    rows.push({
      label: "Signing string",
      value: config.signingString === "raw" ? "raw body" : config.signingString.template,
    });
    if (config.scheme === "asymmetric") {
      rows.push({ label: "Public key", value: config.publicKeyEncoding ?? "pem" });
    }
  } else if (config.scheme === "shared-secret") {
    rows.push({ label: "Placement", value: config.placement });
    if (config.fieldName) rows.push({ label: "Field name", value: config.fieldName });
  } else {
    rows.push({ label: "Placement", value: config.placement });
    rows.push({ label: "Param name", value: config.paramName });
  }

  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-text-dimmed">{row.label}</dt>
            <dd className="truncate font-mono text-xs leading-5 text-text-bright">{row.value}</dd>
          </div>
        ))}
      </dl>
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
      return [source.name, ...(source.fallback ?? [])].map((name) => `header ${name}`).join(" or ");
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

const PREVIOUS_SECRET_TTL_OPTIONS = [
  { value: "0", label: "Stop immediately" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "24 hours" },
  { value: "604800", label: "7 days" },
];

function PreviousSecretTtlField({ credentialNoun }: { credentialNoun: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>Keep accepting the old {credentialNoun} for</Label>
      <Select
        name="previousSecretTtlSeconds"
        variant="tertiary/medium"
        dropdownIcon
        items={PREVIOUS_SECRET_TTL_OPTIONS}
        defaultValue="86400"
        text={(value) => PREVIOUS_SECRET_TTL_OPTIONS.find((o) => o.value === value)?.label}
      >
        {PREVIOUS_SECRET_TTL_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </Select>
      <Hint>
        Deliveries signed with the old {credentialNoun} still verify until then, so you can update
        the provider without failing any. Stop immediately if the old one leaked.
      </Hint>
    </div>
  );
}

function SetSecretDialog({
  hasSigningSecret,
  credentialNoun,
  variant = "secondary/small",
  disabledReason,
}: {
  hasSigningSecret: boolean;
  credentialNoun: string;
  variant?: "secondary/small" | "tertiary/small";
  disabledReason?: string;
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
        <Button
          variant={variant}
          LeadingIcon={KeyIcon}
          disabled={disabledReason !== undefined}
          tooltip={disabledReason}
        >
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
          {hasSigningSecret ? <PreviousSecretTtlField credentialNoun={credentialNoun} /> : null}
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

// Removes the signing secret. Deliveries are rejected until a new one is set; a source that sends its
// own secret (Notion) stores the next verification token, which is how a re-created subscription
// gets its new token onto the endpoint.
function ClearSecretDialog({
  credentialNoun,
  capturesSecret,
  disabledReason,
}: {
  credentialNoun: string;
  capturesSecret: boolean;
  disabledReason?: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="tertiary/small"
          LeadingIcon={TrashIcon}
          disabled={disabledReason !== undefined}
          tooltip={disabledReason}
        >
          Clear {credentialNoun}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Clear {credentialNoun}</DialogHeader>
        <fetcher.Form method="post" className="flex flex-col gap-3 pt-2">
          <input type="hidden" name="intent" value="clear-secret" />
          <Paragraph variant="small" className="text-text-dimmed">
            Every delivery to this endpoint is rejected until a new {credentialNoun} is set.
          </Paragraph>
          {capturesSecret ? (
            <Paragraph variant="small" className="text-text-dimmed">
              The provider's next verification request is stored as the new signing secret. Clear it
              before you re-create the subscription or resend its verification token.
            </Paragraph>
          ) : null}
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
            <Button type="submit" variant="danger/small" disabled={isSubmitting}>
              {isSubmitting ? "Clearing…" : `Clear ${credentialNoun}`}
            </Button>
          </div>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

// The provider sent this secret in its verification request and the endpoint adopted it. The
// provider asks for it back to confirm the subscription, so it stays visible until hidden.
function CapturedSecret({ secret }: { secret: string }) {
  const fetcher = useFetcher<typeof action>();
  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <Hint>
        The provider sent this verification token, which is now the signing secret. Paste it into
        the provider to verify the subscription.
      </Hint>
      <ClipboardField value={secret} variant="secondary/small" secure secureRevealStart={7} />
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="hide-captured-secret" />
        <Button type="submit" variant="tertiary/small" disabled={fetcher.state !== "idle"}>
          Hide token
        </Button>
      </fetcher.Form>
    </div>
  );
}

// For integrator-supplied secrets (GitHub/GitLab/standard): mint a strong secret server-side,
// store it, and reveal it ONCE so the user can paste it into their provider.
function GenerateSecretDialog({
  hasSigningSecret,
  disabledReason,
}: {
  hasSigningSecret: boolean;
  disabledReason?: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  const generated =
    fetcher.data && "generatedSecret" in fetcher.data ? fetcher.data.generatedSecret : undefined;
  const previousSecretExpiresAt =
    fetcher.data && "previousSecretExpiresAt" in fetcher.data
      ? fetcher.data.previousSecretExpiresAt
      : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="secondary/small"
          LeadingIcon={SparklesIcon}
          disabled={disabledReason !== undefined}
          tooltip={disabledReason}
        >
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
            {previousSecretExpiresAt ? (
              <Hint>
                The previous secret keeps verifying deliveries until{" "}
                <DateTime date={previousSecretExpiresAt} />.
              </Hint>
            ) : null}
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
            {hasSigningSecret ? <PreviousSecretTtlField credentialNoun="signing secret" /> : null}
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
function GenerateVerifyTokenDialog({
  hasVerifyToken,
  disabledReason,
}: {
  hasVerifyToken: boolean;
  disabledReason?: string;
}) {
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
        <Button
          variant="secondary/small"
          LeadingIcon={SparklesIcon}
          disabled={disabledReason !== undefined}
          tooltip={disabledReason}
        >
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

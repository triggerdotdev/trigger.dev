import { LinkButton } from "~/components/primitives/Buttons";
import { Form, useFetcher, useRevalidator, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { canAccessPrivateConnections } from "~/v3/canAccessPrivateConnections.server";
import { logger } from "~/services/logger.server";
import { getPrivateLinks } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3PrivateConnectionsPath,
} from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import type { PrivateLinkConnectionStatus } from "@trigger.dev/platform";
import { Button } from "~/components/primitives/Buttons";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { deletePrivateLink } from "~/services/platform.v3.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import {
  ClipboardDocumentIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { useMemo, useState } from "react";
import { useInterval } from "~/hooks/useInterval";

export const meta: MetaFunction = () => {
  return [{ title: `Private Connections | Trigger.dev` }];
};

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const canAccess = await canAccessPrivateConnections({ organizationSlug, userId });
  if (!canAccess) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const [error, connections] = await tryCatch(getPrivateLinks(organization.id));
  if (error) {
    logger.error("Error loading private link connections", { error, organizationId: organization.id });
  }

  return typedjson({
    connections: connections?.connections ?? [],
    organizationId: organization.id,
  });
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  if (request.method !== "DELETE" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const formData = await request.formData();
  const connectionId = formData.get("connectionId");
  const intent = formData.get("intent");

  if (intent !== "delete" || typeof connectionId !== "string") {
    return json({ error: "Invalid request" }, { status: 400 });
  }

  const organization = await prisma.organization.findFirst({
    where: { slug: organizationSlug, members: { some: { userId } } },
  });

  if (!organization) {
    return redirectWithErrorMessage(
      v3PrivateConnectionsPath({ slug: organizationSlug }),
      request,
      "Organization not found"
    );
  }

  const [error] = await tryCatch(deletePrivateLink(organization.id, connectionId));
  if (error) {
    return redirectWithErrorMessage(
      v3PrivateConnectionsPath({ slug: organizationSlug }),
      request,
      `Failed to delete connection: ${error.message}`
    );
  }

  return redirectWithSuccessMessage(
    v3PrivateConnectionsPath({ slug: organizationSlug }),
    request,
    "Connection deletion initiated"
  );
};

const STATUS_COLORS: Record<PrivateLinkConnectionStatus, string> = {
  PENDING: "bg-amber-500/20 text-amber-400",
  PROVISIONING: "bg-blue-500/20 text-blue-400",
  ACTIVE: "bg-emerald-500/20 text-emerald-400",
  ERROR: "bg-rose-500/20 text-rose-400",
  DELETING: "bg-charcoal-500/20 text-charcoal-400",
};

function StatusBadge({ status }: { status: PrivateLinkConnectionStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}
    >
      {status}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="ml-1 inline-flex items-center text-text-dimmed transition hover:text-text-bright"
      title="Copy to clipboard"
    >
      <ClipboardDocumentIcon className="h-3.5 w-3.5" />
      {copied && <span className="ml-1 text-xs text-emerald-400">Copied</span>}
    </button>
  );
}

const TERMINAL_STATUSES: PrivateLinkConnectionStatus[] = ["ACTIVE", "ERROR"];

export default function Page() {
  const { connections } = useTypedLoaderData<typeof loader>();
  const plan = useCurrentPlan();
  const revalidator = useRevalidator();

  const hasInProgressConnections = useMemo(
    () => connections.some((c) => !TERMINAL_STATUSES.includes(c.status)),
    [connections]
  );

  useInterval({
    interval: 3_000,
    onLoad: false,
    callback: () => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    },
    disabled: !hasInProgressConnections,
  });

  const hasPrivateNetworking = plan?.v3Subscription?.plan?.limits?.hasPrivateNetworking ?? false;
  const limit = plan?.v3Subscription?.plan?.limits?.privateLinkConnectionLimit ?? 2;
  const canAdd = connections.filter((c) => c.status !== "DELETING").length < limit;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Private Connections" />
        <PageAccessories>
          {hasPrivateNetworking && canAdd && (
            <LinkButton variant="primary/small" LeadingIcon={PlusIcon} to="new">
              Add Connection
            </LinkButton>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={true}>
        <MainHorizontallyCenteredContainer className="max-w-3xl">
          <div>
            <div className="mb-4 border-b border-grid-dimmed pb-3">
              <Header2 spacing>Private Connections</Header2>
              <Paragraph variant="small">
                Connect your AWS resources (databases, caches, APIs) to your Trigger.dev tasks via
                AWS PrivateLink. Connections are organization-wide and work across all projects and
                environments.
              </Paragraph>
            </div>

            {!hasPrivateNetworking ? (
              <div className="rounded-lg border border-grid-dimmed p-6 text-center">
                <Paragraph variant="small" className="text-text-dimmed">
                  Private Connections require upgrading to Pro or an Enterprise plan.
                </Paragraph>
              </div>
            ) : connections.length === 0 ? (
              <div className="rounded-lg border border-grid-dimmed p-6 text-center">
                <Paragraph variant="small" className="mb-4 text-text-dimmed">
                  No private connections yet. Add your first connection to securely reach your AWS
                  resources from task pods.
                </Paragraph>
                <LinkButton variant="primary/small" LeadingIcon={PlusIcon} to="new">
                  Add Connection
                </LinkButton>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="rounded-lg border border-grid-dimmed p-4"
                  >
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <span className="font-medium text-text-bright">
                          {connection.name}
                        </span>
                        <StatusBadge status={connection.status} />
                        {connection.status !== "DELETING" && (
                          <Form method="POST" className="ml-auto">
                            <input type="hidden" name="connectionId" value={connection.id} />
                            <input type="hidden" name="intent" value="delete" />
                            <button
                              type="submit"
                              className="text-text-dimmed transition hover:text-rose-400"
                              title="Delete connection"
                              onClick={(e) => {
                                if (
                                  !confirm(
                                    `Delete connection "${connection.name}"? This will remove the VPC Endpoint and network access.`
                                  )
                                ) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              <TrashIcon className="h-4 w-4" />
                            </button>
                          </Form>
                        )}
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center text-xs text-text-dimmed">
                          <span className="w-24 shrink-0">Service:</span>
                          <code className="truncate font-mono text-text-dimmed">
                            {connection.endpointServiceName}
                          </code>
                          <CopyButton value={connection.endpointServiceName} />
                        </div>
                        <div className="flex items-center text-xs text-text-dimmed">
                          <span className="w-24 shrink-0">Region:</span>
                          <span>{connection.targetRegion}</span>
                        </div>
                        {connection.endpointDnsName && (
                          <div className="flex items-center text-xs text-text-dimmed">
                            <span className="w-24 shrink-0">DNS:</span>
                            <code className="truncate font-mono text-emerald-400">
                              {connection.endpointDnsName}
                            </code>
                            <CopyButton value={connection.endpointDnsName} />
                          </div>
                        )}
                        {connection.statusMessage && (
                          <div className="flex items-center text-xs text-rose-400">
                            <span className="w-24 shrink-0">Error:</span>
                            <span>{connection.statusMessage}</span>
                          </div>
                        )}
                        <div className="flex items-center text-xs text-text-dimmed">
                          <span className="w-24 shrink-0">Created:</span>
                          <span>
                            {new Date(connection.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {!canAdd && (
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Connection limit reached ({limit}). Delete an existing connection to add a new
                    one.
                  </Paragraph>
                )}
              </div>
            )}
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

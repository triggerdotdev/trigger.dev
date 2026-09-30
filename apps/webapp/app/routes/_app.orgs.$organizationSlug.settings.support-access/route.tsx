import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import type { SupportAccessMode } from "@trigger.dev/database";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getImpersonationState } from "~/services/impersonation.server";
import { getUserId } from "~/services/session.server";
import { SupportAccessService } from "~/services/supportAccess.server";
import { SUPPORT_ACCESS_APPROVAL_DAYS, pendingRequestCutoff } from "~/utils/supportAccess";
import { cn } from "~/utils/cn";
import { pageMeta } from "~/utils/pageTitle";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

export const meta = pageMeta("Support Access");

const Params = z.object({ organizationSlug: z.string() });

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("setMode"), mode: z.enum(["ALLOW", "REQUIRES_REQUEST"]) }),
  z.object({ intent: z.literal("approve"), requestId: z.string() }),
  z.object({ intent: z.literal("cancel"), requestId: z.string() }),
]);

const authorization = { action: "manage", resource: { type: "supportAccess" } } as const;

function requireManagedCloud(request: Request) {
  if (!featuresForRequest(request).isManagedCloud) {
    throw new Response("Not Found", { status: 404 });
  }
}

// Hidden until every webapp enforces the setting, so it can't be turned on before it's honoured.
// Orgs already requiring requests keep the page, so their approvers aren't locked out.
async function requireSettingsEnabled(organizationId: string) {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true, supportAccessMode: true },
  });
  if (org?.supportAccessMode === "REQUIRES_REQUEST") return;
  const overrides = org?.featureFlags;
  const enabled = await makeFlag(prisma)({
    key: FEATURE_FLAG.supportAccessSettingsEnabled,
    defaultValue: false,
    overrides:
      overrides && typeof overrides === "object" && !Array.isArray(overrides)
        ? overrides
        : undefined,
  });
  if (!enabled) {
    throw new Response("Not Found", { status: 404 });
  }
}

// Scoped to membership: ability.can is not a tenant floor.
async function context(params: z.infer<typeof Params>, request: Request) {
  const userId = await getUserId(request);
  if (!userId) return {};
  const org = await prisma.organization.findFirst({
    where: { slug: params.organizationSlug, deletedAt: null, members: { some: { userId } } },
    select: { id: true },
  });
  return org ? { organizationId: org.id } : {};
}

export const loader = dashboardLoader(
  { params: Params, context, authorization },
  async ({ request, context, user }) => {
    requireManagedCloud(request);
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }
    await requireSettingsEnabled(organizationId);

    const org = await prisma.organization.findFirst({
      where: { id: organizationId },
      select: { supportAccessMode: true },
    });
    const requests = await new SupportAccessService().listRequests(organizationId);
    if (!org || requests.isErr()) {
      throw new Response("Failed to load Support Access", { status: 500 });
    }

    const now = new Date();
    const pendingCutoff = pendingRequestCutoff(now);
    const isExpired = (r: (typeof requests.value)[number]) =>
      (r.status === "APPROVED" && r.expiresAt !== null && r.expiresAt <= now) ||
      (r.status === "PENDING" && r.createdAt <= pendingCutoff);
    return typedjson({
      mode: org.supportAccessMode,
      readOnly: (await getImpersonationState(request, user.id)).isImpersonating,
      requests: requests.value.map((r) => ({
        id: r.id,
        reason: r.reason,
        requestedBy: r.requestedBy?.email ?? "Former Trigger.dev staff",
        createdAt: r.createdAt,
        approvedBy: r.approvedBy?.email ?? null,
        expiresAt: r.expiresAt,
        status: isExpired(r) ? ("EXPIRED" as const) : r.status,
      })),
    });
  }
);

export const action = dashboardAction(
  { params: Params, context, authorization },
  async ({ request, context, user }) => {
    requireManagedCloud(request);
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }
    await requireSettingsEnabled(organizationId);
    // Staff viewing the dashboard as a customer must not approve their own access.
    if ((await getImpersonationState(request, user.id)).isImpersonating) {
      return jsonWithErrorMessage(
        { ok: false },
        request,
        "Support Access can't be changed during a Support Access session."
      );
    }

    const parsed = ActionSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) {
      return new Response("Bad Request", { status: 400 });
    }

    const service = new SupportAccessService();
    const input = parsed.data;

    switch (input.intent) {
      case "setMode": {
        const result = await service.setMode({
          organizationId,
          mode: input.mode,
          updatedById: user.id,
        });
        if (result.isErr()) {
          return jsonWithErrorMessage({ ok: false }, request, "Couldn't save the access mode.");
        }
        const cancelled = result.value.cancelledPending;
        return jsonWithSuccessMessage(
          { ok: true },
          request,
          cancelled > 0 ? `Saved. ${cancelled} pending request(s) cancelled.` : "Saved."
        );
      }
      case "approve": {
        const result = await service.approveRequest({
          organizationId,
          requestId: input.requestId,
          approvedById: user.id,
        });
        if (result.isErr()) {
          return jsonWithErrorMessage({ ok: false }, request, "This request is no longer pending.");
        }
        return jsonWithSuccessMessage(
          { ok: true },
          request,
          `Approved. The Trigger.dev support team has access for ${SUPPORT_ACCESS_APPROVAL_DAYS} days.`
        );
      }
      case "cancel": {
        const result = await service.cancelRequest({
          organizationId,
          requestId: input.requestId,
          cancelledById: user.id,
        });
        if (result.isErr()) {
          return jsonWithErrorMessage({ ok: false }, request, "This request is no longer pending.");
        }
        return jsonWithSuccessMessage({ ok: true }, request, "Request cancelled.");
      }
    }
  }
);

const MODES: { id: SupportAccessMode; name: string; description: string }[] = [
  {
    id: "ALLOW",
    name: "Allow",
    description: "Trigger.dev support can access your dashboard when helping you.",
  },
  {
    id: "REQUIRES_REQUEST",
    name: "Requires request",
    description: `Trigger.dev support must request access, and an Owner or Admin must approve it before they can view your dashboard. An approval gives the Trigger.dev support team access for ${SUPPORT_ACCESS_APPROVAL_DAYS} days.`,
  },
];

const STATUS_LABEL = {
  PENDING: { label: "Pending", className: "text-warning" },
  APPROVED: { label: "Approved", className: "text-success" },
  CANCELLED: { label: "Cancelled", className: "text-text-dimmed" },
  EXPIRED: { label: "Expired", className: "text-text-dimmed" },
} as const;

export default function Page() {
  const { mode, readOnly, requests } = useTypedLoaderData<typeof loader>();
  const modeFetcher = useFetcher();
  const pendingMode = modeFetcher.formData?.get("mode") as SupportAccessMode | undefined;
  const currentMode = pendingMode ?? mode;
  const currentModeInfo = MODES.find((m) => m.id === currentMode) ?? MODES[0];
  const requiresRequest = MODES.find((m) => m.id === "REQUIRES_REQUEST") ?? MODES[1];
  const [confirmOpen, setConfirmOpen] = useState(false);

  const submitMode = (value: SupportAccessMode) =>
    modeFetcher.submit({ intent: "setMode", mode: value }, { method: "post" });

  // Turning on Requires request affects the whole org, so it's confirmed first.
  const changeMode = (value: SupportAccessMode) => {
    if (value === currentMode) return;
    if (value === "REQUIRES_REQUEST") {
      setConfirmOpen(true);
      return;
    }
    submitMode(value);
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Support Access" />
      </NavBar>
      <PageBody scrollable={true}>
        <SettingsContainer className="max-w-[60rem]">
          <SettingsSection>
            <SettingsHeader
              title="Support Access"
              description="Control whether the Trigger.dev team can access your organization's dashboard to help with support."
            />
            {readOnly && (
              <Callout variant="info" className="mt-4">
                You're viewing this page in a Support Access session, so it's read-only.
              </Callout>
            )}
            <SettingsRow
              title="Access mode"
              description={currentModeInfo.description}
              action={
                <Select<SupportAccessMode, (typeof MODES)[number]>
                  value={currentMode}
                  setValue={changeMode}
                  items={MODES}
                  variant="secondary/small"
                  dropdownIcon
                  disabled={readOnly}
                  placement="bottom-end"
                  text={(value) => MODES.find((m) => m.id === value)?.name ?? ""}
                >
                  {(items) =>
                    items.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))
                  }
                </Select>
              }
            />
          </SettingsSection>

          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>Require requests for Support Access?</DialogHeader>
              <DialogDescription>{requiresRequest.description}</DialogDescription>
              <DialogFooter>
                <Button variant="tertiary/small" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary/small"
                  onClick={() => {
                    setConfirmOpen(false);
                    submitMode("REQUIRES_REQUEST");
                  }}
                >
                  Require requests
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {currentMode === "REQUIRES_REQUEST" && (
            <SettingsSection>
              <SettingsHeader title="Access requests" />
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Request</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Expires</TableHeaderCell>
                    <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.length === 0 ? (
                    <TableBlankRow colSpan={4}>
                      <Paragraph variant="small">No requests yet.</Paragraph>
                    </TableBlankRow>
                  ) : (
                    requests.map((request) => (
                      <TableRow key={request.id}>
                        <TableCell className="whitespace-normal">
                          <div className="text-text-bright">{request.reason}</div>
                          <div className="text-xs text-text-dimmed">
                            {request.requestedBy} · <DateTime date={request.createdAt} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusLabel status={request.status} />
                          {request.approvedBy && (
                            <div className="text-xs text-text-dimmed">by {request.approvedBy}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          {request.expiresAt ? <DateTime date={request.expiresAt} /> : "–"}
                        </TableCell>
                        <TableCell alignment="right">
                          {request.status === "PENDING" && (
                            <RequestActions requestId={request.id} disabled={readOnly} />
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </SettingsSection>
          )}
        </SettingsContainer>
      </PageBody>
    </PageContainer>
  );
}

function StatusLabel({ status }: { status: keyof typeof STATUS_LABEL }) {
  const { label, className } = STATUS_LABEL[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span className="inline-block size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function RequestActions({ requestId, disabled }: { requestId: string; disabled: boolean }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post" className="flex justify-end gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <Button
        type="submit"
        name="intent"
        value="cancel"
        variant="tertiary/small"
        disabled={disabled || busy}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        name="intent"
        value="approve"
        variant="primary/small"
        disabled={disabled || busy}
      >
        Approve
      </Button>
    </fetcher.Form>
  );
}

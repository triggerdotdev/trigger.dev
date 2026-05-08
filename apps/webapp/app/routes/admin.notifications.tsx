import { ChevronRightIcon, TrashIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useFetcher, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { useEffect, useRef, useState, useLayoutEffect } from "react";
import ReactMarkdown from "react-markdown";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  Alert,
  AlertCancel,
  AlertContent,
  AlertDescription,
  AlertFooter,
  AlertHeader,
  AlertTitle,
  AlertTrigger,
} from "~/components/primitives/Alert";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  archivePlatformNotification,
  createPlatformNotification,
  deletePlatformNotification,
  getAdminNotificationsList,
  publishNowPlatformNotification,
  updatePlatformNotification,
} from "~/services/platformNotifications.server";
import { createSearchParams } from "~/utils/searchParams";
import { cn } from "~/utils/cn";

const PAGE_SIZE = 20;

const WEBAPP_TYPES = ["card", "changelog"] as const;
const CLI_TYPES = ["info", "warn", "error", "success"] as const;

const SearchParams = z.object({
  page: z.coerce.number().optional(),
  hideInactive: z.coerce.boolean().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.admin) throw redirect("/");

  const searchParams = createSearchParams(request.url, SearchParams);
  if (!searchParams.success) throw new Error(searchParams.error);
  const { page: rawPage, hideInactive } = searchParams.params.getAll();
  const page = rawPage ?? 1;

  const data = await getAdminNotificationsList({ page, pageSize: PAGE_SIZE, hideInactive: hideInactive ?? false });

  return typedjson({ ...data, userId });
};

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.admin) throw redirect("/");

  const formData = await request.formData();
  const _action = formData.get("_action");

  if (_action === "create" || _action === "create-preview") {
    return handleCreateAction(formData, userId, _action === "create-preview");
  }

  if (_action === "archive") {
    return handleArchiveAction(formData);
  }

  if (_action === "delete") {
    return handleDeleteAction(formData);
  }

  if (_action === "publish-now") {
    return handlePublishNowAction(formData);
  }

  if (_action === "edit") {
    return handleEditAction(formData);
  }

  return typedjson({ error: "Unknown action" }, { status: 400 });
}

function parseNotificationFormData(formData: FormData) {
  const surface = formData.get("surface") as string;
  const payloadType = formData.get("payloadType") as string;
  const adminLabel = formData.get("adminLabel") as string;
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const actionUrl = (formData.get("actionUrl") as string) || undefined;
  const image = (formData.get("image") as string) || undefined;
  const dismissOnAction = formData.get("dismissOnAction") === "true";
  const startsAt = formData.get("startsAt") as string;
  const endsAt = formData.get("endsAt") as string;
  const priority = Number(formData.get("priority") || "0");
  const scope = (formData.get("scope") as string) || "GLOBAL";
  const scopeUserId = (formData.get("scopeUserId") as string) || undefined;
  const scopeOrganizationId = (formData.get("scopeOrganizationId") as string) || undefined;
  const scopeProjectId = (formData.get("scopeProjectId") as string) || undefined;

  const cliMaxShowCount = formData.get("cliMaxShowCount")
    ? Number(formData.get("cliMaxShowCount"))
    : undefined;
  const cliMaxDaysAfterFirstSeen = formData.get("cliMaxDaysAfterFirstSeen")
    ? Number(formData.get("cliMaxDaysAfterFirstSeen"))
    : undefined;
  const cliShowEvery = formData.get("cliShowEvery")
    ? Number(formData.get("cliShowEvery"))
    : undefined;

  const discoveryFilePatterns = (formData.get("discoveryFilePatterns") as string) || "";
  const discoveryContentPattern =
    (formData.get("discoveryContentPattern") as string) || undefined;
  const discoveryMatchBehavior = (formData.get("discoveryMatchBehavior") as string) || "";

  const discovery =
    discoveryFilePatterns && discoveryMatchBehavior
      ? {
          filePatterns: discoveryFilePatterns
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          ...(discoveryContentPattern ? { contentPattern: discoveryContentPattern } : {}),
          matchBehavior: discoveryMatchBehavior as "show-if-found" | "show-if-not-found",
        }
      : undefined;

  return {
    surface,
    payloadType,
    adminLabel,
    title,
    description,
    actionUrl,
    image,
    dismissOnAction,
    startsAt,
    endsAt,
    priority,
    scope,
    scopeUserId,
    scopeOrganizationId,
    scopeProjectId,
    cliMaxShowCount,
    cliMaxDaysAfterFirstSeen,
    cliShowEvery,
    discovery,
  };
}

function buildPayloadInput(fields: ReturnType<typeof parseNotificationFormData>) {
  return {
    version: "1" as const,
    data: {
      type: fields.payloadType as "info" | "warn" | "error" | "success" | "card" | "changelog",
      title: fields.title,
      description: fields.description,
      ...(fields.actionUrl ? { actionUrl: fields.actionUrl } : {}),
      ...(fields.image ? { image: fields.image } : {}),
      ...(fields.dismissOnAction ? { dismissOnAction: true } : {}),
      ...(fields.discovery ? { discovery: fields.discovery } : {}),
    },
  };
}

async function handleCreateAction(formData: FormData, userId: string, isPreview: boolean) {
  const fields = parseNotificationFormData(formData);

  if (!fields.adminLabel || !fields.title || !fields.description || !fields.endsAt || !fields.surface || !fields.payloadType) {
    return typedjson({ error: "Missing required fields" }, { status: 400 });
  }

  const result = await createPlatformNotification({
    title: isPreview ? `[Preview] ${fields.adminLabel}` : fields.adminLabel,
    payload: buildPayloadInput(fields),
    surface: fields.surface as "CLI" | "WEBAPP",
    scope: isPreview ? "USER" : (fields.scope as "USER" | "PROJECT" | "ORGANIZATION" | "GLOBAL"),
    ...(isPreview
      ? { userId }
      : {
          ...(fields.scope === "USER" && fields.scopeUserId ? { userId: fields.scopeUserId } : {}),
          ...(fields.scope === "ORGANIZATION" && fields.scopeOrganizationId ? { organizationId: fields.scopeOrganizationId } : {}),
          ...(fields.scope === "PROJECT" && fields.scopeProjectId ? { projectId: fields.scopeProjectId } : {}),
        }),
    startsAt: isPreview
      ? new Date().toISOString()
      : fields.startsAt
        ? new Date(fields.startsAt + "Z").toISOString()
        : new Date().toISOString(),
    endsAt: isPreview
      ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
      : new Date(fields.endsAt + "Z").toISOString(),
    priority: fields.priority,
    ...(fields.surface === "CLI"
      ? isPreview
        ? { cliMaxShowCount: 1 }
        : {
            cliMaxShowCount: fields.cliMaxShowCount,
            cliMaxDaysAfterFirstSeen: fields.cliMaxDaysAfterFirstSeen,
            cliShowEvery: fields.cliShowEvery,
          }
      : {}),
  });

  if (result.isErr()) {
    const err = result.error;
    if (err.type === "validation") {
      return typedjson(
        { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 }
      );
    }
    logger.error("Failed to create platform notification", { error: err });
    return typedjson({ error: "Something went wrong" }, { status: 500 });
  }

  if (isPreview) {
    return typedjson({ success: true, previewId: result.value.id });
  }
  return typedjson({ success: true, id: result.value.id });
}

async function handleArchiveAction(formData: FormData) {
  const notificationId = formData.get("notificationId") as string;
  if (!notificationId) {
    return typedjson({ error: "Missing notificationId" }, { status: 400 });
  }

  try {
    await archivePlatformNotification(notificationId);
    return typedjson({ success: true });
  } catch (error) {
    logger.error("Failed to archive platform notification", { error, notificationId });
    return typedjson({ error: "Failed to archive notification" }, { status: 500 });
  }
}

async function handleDeleteAction(formData: FormData) {
  const notificationId = formData.get("notificationId") as string;
  if (!notificationId) {
    return typedjson({ error: "Missing notificationId" }, { status: 400 });
  }

  try {
    await deletePlatformNotification(notificationId);
    return typedjson({ success: true });
  } catch (error) {
    logger.error("Failed to delete platform notification", { error, notificationId });
    return typedjson({ error: "Failed to delete notification" }, { status: 500 });
  }
}

async function handlePublishNowAction(formData: FormData) {
  const notificationId = formData.get("notificationId") as string;
  if (!notificationId) {
    return typedjson({ error: "Missing notificationId" }, { status: 400 });
  }

  try {
    await publishNowPlatformNotification(notificationId);
    return typedjson({ success: true });
  } catch (error) {
    logger.error("Failed to publish platform notification", { error, notificationId });
    return typedjson({ error: "Failed to publish notification" }, { status: 500 });
  }
}

async function handleEditAction(formData: FormData) {
  const notificationId = formData.get("notificationId") as string;
  const fields = parseNotificationFormData(formData);

  if (!notificationId || !fields.adminLabel || !fields.title || !fields.description || !fields.endsAt || !fields.surface || !fields.payloadType || !fields.startsAt) {
    return typedjson({ error: "Missing required fields" }, { status: 400 });
  }

  const result = await updatePlatformNotification({
    id: notificationId,
    title: fields.adminLabel,
    payload: buildPayloadInput(fields),
    surface: fields.surface as "CLI" | "WEBAPP",
    scope: fields.scope as "USER" | "PROJECT" | "ORGANIZATION" | "GLOBAL",
    ...(fields.scope === "USER" && fields.scopeUserId ? { userId: fields.scopeUserId } : {}),
    ...(fields.scope === "ORGANIZATION" && fields.scopeOrganizationId ? { organizationId: fields.scopeOrganizationId } : {}),
    ...(fields.scope === "PROJECT" && fields.scopeProjectId ? { projectId: fields.scopeProjectId } : {}),
    startsAt: new Date(fields.startsAt + "Z").toISOString(),
    endsAt: new Date(fields.endsAt + "Z").toISOString(),
    priority: fields.priority,
    ...(fields.surface === "CLI"
      ? {
          cliMaxShowCount: fields.cliMaxShowCount,
          cliMaxDaysAfterFirstSeen: fields.cliMaxDaysAfterFirstSeen,
          cliShowEvery: fields.cliShowEvery,
        }
      : {}),
  });

  if (result.isErr()) {
    const err = result.error;
    if (err.type === "validation") {
      return typedjson(
        { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 }
      );
    }
    logger.error("Failed to update platform notification", { error: err });
    return typedjson({ error: "Something went wrong" }, { status: 500 });
  }

  return typedjson({ success: true, id: result.value.id });
}

export default function AdminNotificationsRoute() {
  const { notifications, total, page, pageCount } = useTypedLoaderData<typeof loader>();
  const [showCreate, setShowCreate] = useState(false);
  const [detailNotification, setDetailNotification] = useState<(typeof notifications)[number] | null>(null);
  const [editNotification, setEditNotification] = useState<(typeof notifications)[number] | null>(null);

  const [urlSearchParams, setUrlSearchParams] = useSearchParams();
  const hideInactive = urlSearchParams.get("hideInactive") === "true";

  const toggleHideInactive = () => {
    setUrlSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (hideInactive) {
        next.delete("hideInactive");
      } else {
        next.set("hideInactive", "true");
      }
      next.delete("page");
      return next;
    });
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Button variant="primary/small" onClick={() => setShowCreate(true)}>
            Create Notification
          </Button>
        </div>

        <Dialog
          open={showCreate}
          onOpenChange={(open) => { if (!open) setShowCreate(false); }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Notification</DialogTitle>
            </DialogHeader>
            <NotificationForm
              key="create"
              mode="create"
              onClose={() => setShowCreate(false)}
            />
          </DialogContent>
        </Dialog>

        <div className="flex items-center justify-between">
          <Paragraph className="text-text-dimmed">
            {total} notifications (page {page} of {pageCount || 1})
          </Paragraph>
          <label className="flex items-center gap-2 text-xs text-text-dimmed">
            <input
              type="checkbox"
              checked={hideInactive}
              onChange={toggleHideInactive}
              className="rounded border-grid-dimmed bg-charcoal-900"
            />
            Hide inactive
          </label>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Title</TableHeaderCell>
              <TableHeaderCell>Surface</TableHeaderCell>
              <TableHeaderCell>Scope</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Starts (UTC)</TableHeaderCell>
              <TableHeaderCell>Ends (UTC)</TableHeaderCell>
              <TableHeaderCell>Seen</TableHeaderCell>
              <TableHeaderCell>Clicked</TableHeaderCell>
              <TableHeaderCell>Dismissed</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {notifications.length === 0 ? (
              <TableBlankRow colSpan={10}>
                <Paragraph>No notifications found</Paragraph>
              </TableBlankRow>
            ) : (
              notifications.map((n) => {
                const status = getNotificationStatus(n);
                const isActive = status === "active";
                return (
                  <TableRow key={n.id} className="group/row">
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setDetailNotification(n)}
                        className="text-sm font-medium text-text-bright hover:text-indigo-400 transition-colors text-left"
                      >
                        {n.title}
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge color={n.surface === "CLI" ? "amber" : "blue"}>{n.surface}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge color={n.scope === "GLOBAL" ? "green" : "gray"}>{n.scope}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-text-dimmed">{n.payloadType ?? "—"}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-text-dimmed">{formatDate(n.startsAt)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-text-dimmed">{formatDate(n.endsAt)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-mono">{n.stats.seen}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-mono">{n.stats.clicked}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-mono">{n.stats.dismissed}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                        {status === "pending" && (
                          <PublishNowButton notificationId={n.id} />
                        )}
                        {(status === "pending" || status === "releasing" || status === "active") && (
                          <Button
                            variant="tertiary/small"
                            onClick={() => setEditNotification(n)}
                          >
                            Edit
                          </Button>
                        )}
                        {status !== "archived" && (
                          <ArchiveButton notificationId={n.id} />
                        )}
                        <DeleteConfirmationButton notificationId={n.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PaginationControls currentPage={page} totalPages={pageCount} />
      </div>

      <Dialog
        open={detailNotification !== null}
        onOpenChange={(open) => {
          if (!open) setDetailNotification(null);
        }}
      >
        <DialogContent className="max-w-lg">
          {detailNotification && (
            <>
              <DialogHeader>
                <DialogTitle>{detailNotification.title}</DialogTitle>
              </DialogHeader>
              <NotificationDetailContent notification={detailNotification} />
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={editNotification !== null}
        onOpenChange={(open) => {
          if (!open) setEditNotification(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {editNotification && (
            <>
              <DialogHeader>
                <DialogTitle>Edit Notification</DialogTitle>
              </DialogHeader>
              <NotificationForm
                key={editNotification.id}
                mode="edit"
                notification={editNotification}
                onClose={() => setEditNotification(null)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ArchiveButton({ notificationId }: { notificationId: string }) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post" className="inline">
      <input type="hidden" name="_action" value="archive" />
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" variant="danger/small" disabled={fetcher.state !== "idle"}>
        Archive
      </Button>
    </fetcher.Form>
  );
}

function PublishNowButton({ notificationId }: { notificationId: string }) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher();

  return (
    <Alert open={open} onOpenChange={setOpen}>
      <AlertTrigger asChild>
        <Button variant="secondary/small">Publish Now</Button>
      </AlertTrigger>
      <AlertContent>
        <AlertHeader>
          <AlertTitle>Publish notification now</AlertTitle>
          <AlertDescription>
            This will make the notification immediately visible to users.
          </AlertDescription>
        </AlertHeader>
        <AlertFooter>
          <AlertCancel asChild>
            <Button variant="secondary/small">Cancel</Button>
          </AlertCancel>
          <fetcher.Form method="post" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="_action" value="publish-now" />
            <input type="hidden" name="notificationId" value={notificationId} />
            <Button type="submit" variant="primary/small">
              Publish
            </Button>
          </fetcher.Form>
        </AlertFooter>
      </AlertContent>
    </Alert>
  );
}

function DeleteConfirmationButton({ notificationId }: { notificationId: string }) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher();

  return (
    <Alert open={open} onOpenChange={setOpen}>
      <AlertTrigger asChild>
        <Button variant="tertiary/small">
          <TrashIcon className="size-3.5 text-text-dimmed" />
        </Button>
      </AlertTrigger>
      <AlertContent>
        <AlertHeader>
          <AlertTitle>Delete notification</AlertTitle>
          <AlertDescription>
            This will permanently delete this notification and all its interaction data. This
            action cannot be undone.
          </AlertDescription>
        </AlertHeader>
        <AlertFooter>
          <AlertCancel asChild>
            <Button variant="secondary/small">Cancel</Button>
          </AlertCancel>
          <fetcher.Form method="post" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="_action" value="delete" />
            <input type="hidden" name="notificationId" value={notificationId} />
            <Button type="submit" variant="danger/small">
              Delete
            </Button>
          </fetcher.Form>
        </AlertFooter>
      </AlertContent>
    </Alert>
  );
}

type NotificationFormDefaults = {
  id?: string;
  title?: string;
  surface?: string;
  scope?: string;
  userId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  priority?: number;
  startsAt?: Date;
  endsAt?: Date;
  payloadTitle?: string | null;
  payloadType?: string | null;
  payloadDescription?: string | null;
  payloadActionUrl?: string | null;
  payloadImage?: string | null;
  payloadDismissOnAction?: boolean;
  payloadDiscovery?: {
    filePatterns: string[];
    contentPattern?: string;
    matchBehavior: "show-if-found" | "show-if-not-found";
  } | null;
  cliMaxShowCount?: number | null;
  cliMaxDaysAfterFirstSeen?: number | null;
  cliShowEvery?: number | null;
};

function NotificationForm({
  mode,
  notification: n,
  onClose,
}: {
  mode: "create" | "edit";
  notification?: NotificationFormDefaults;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ success?: boolean; error?: string; previewId?: string }>();
  const [surface, setSurface] = useState<"CLI" | "WEBAPP">((n?.surface as "CLI" | "WEBAPP") ?? "WEBAPP");
  const [payloadType, setPayloadType] = useState<string>(n?.payloadType ?? "card");
  const [scope, setScope] = useState<string>(n?.scope ?? "GLOBAL");
  const [title, setTitle] = useState(n?.payloadTitle ?? "");
  const [description, setDescription] = useState(n?.payloadDescription ?? "");
  const [actionUrl, setActionUrl] = useState(n?.payloadActionUrl ?? "");
  const [image, setImage] = useState(n?.payloadImage ?? "");

  const typeOptions = surface === "WEBAPP" ? WEBAPP_TYPES : CLI_TYPES;

  const handleSurfaceChange = (newSurface: "CLI" | "WEBAPP") => {
    setSurface(newSurface);
    const newTypes = newSurface === "WEBAPP" ? WEBAPP_TYPES : CLI_TYPES;
    if (!newTypes.includes(payloadType as any)) {
      setPayloadType(newTypes[0]);
    }
  };

  useEffect(() => {
    if (fetcher.data?.success && !fetcher.data.previewId) {
      onClose();
    }
  }, [fetcher.data, onClose]);

  const isEdit = mode === "edit";

  return (
    <fetcher.Form method="post" className="space-y-3">
      {isEdit && (
        <>
          <input type="hidden" name="_action" value="edit" />
          <input type="hidden" name="notificationId" value={n?.id} />
        </>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-xs font-medium text-text-dimmed">Admin Label</label>
          <Input
            name="adminLabel"
            variant="medium"
            fullWidth
            defaultValue={n?.title ?? ""}
            placeholder="Internal name for this notification"
            className="mt-1"
          />
        </div>

        <div className="w-28">
          <label className="text-xs font-medium text-text-dimmed">Surface</label>
          <select
            name="surface"
            value={surface}
            onChange={(e) => handleSurfaceChange(e.target.value as "CLI" | "WEBAPP")}
            className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
          >
            <option value="WEBAPP">WEBAPP</option>
            <option value="CLI">CLI</option>
          </select>
        </div>

        <div className="w-28">
          <label className="text-xs font-medium text-text-dimmed">Type</label>
          <select
            name="payloadType"
            value={payloadType}
            onChange={(e) => setPayloadType(e.target.value)}
            className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
          >
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="w-16">
          <label className="text-xs font-medium text-text-dimmed">Priority</label>
          <Input
            name="priority"
            variant="medium"
            fullWidth
            defaultValue={String(n?.priority ?? 0)}
            type="number"
            className="mt-1"
          />
        </div>
      </div>

      <div className="flex gap-3">
        <div className="w-36">
          <label className="text-xs font-medium text-text-dimmed">Scope</label>
          <select
            name="scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
          >
            <option value="GLOBAL">GLOBAL</option>
            <option value="USER">USER</option>
            <option value="ORGANIZATION">ORGANIZATION</option>
            <option value="PROJECT">PROJECT</option>
          </select>
        </div>

        {scope === "USER" && (
          <div className="flex-1">
            <label className="text-xs font-medium text-text-dimmed">User ID</label>
            <Input name="scopeUserId" variant="medium" fullWidth defaultValue={n?.userId ?? ""} placeholder="User ID" className="mt-1" />
          </div>
        )}

        {scope === "ORGANIZATION" && (
          <div className="flex-1">
            <label className="text-xs font-medium text-text-dimmed">Organization ID</label>
            <Input name="scopeOrganizationId" variant="medium" fullWidth defaultValue={n?.organizationId ?? ""} placeholder="Organization ID" className="mt-1" />
          </div>
        )}

        {scope === "PROJECT" && (
          <div className="flex-1">
            <label className="text-xs font-medium text-text-dimmed">Project ID</label>
            <Input name="scopeProjectId" variant="medium" fullWidth defaultValue={n?.projectId ?? ""} placeholder="Project ID" className="mt-1" />
          </div>
        )}
      </div>

      {/* CLI live preview */}
      {surface === "CLI" && (title || description) && (
        <div>
          <p className="text-[10px] font-medium text-text-dimmed/60 uppercase tracking-wider mb-1">
            CLI Preview
          </p>
          <div className="rounded border border-grid-dimmed bg-charcoal-900 p-3 font-mono text-xs leading-relaxed">
            {title && (
              <p className="font-bold text-text-bright">
                <CliColorMarkup text={title} fallbackClass="text-text-bright" />
              </p>
            )}
            {description && (
              <p className="text-text-dimmed">
                <CliColorMarkup text={description} fallbackClass="text-text-dimmed" />
              </p>
            )}
            {actionUrl && (
              <p className="text-text-dimmed underline">{actionUrl}</p>
            )}
          </div>
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-text-dimmed">Title</label>
        <Input
          name="title"
          variant="medium"
          fullWidth
          placeholder="Notification title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-text-dimmed">
          Description{surface === "WEBAPP" ? " (markdown)" : ""}
        </label>
        {surface === "WEBAPP" ? (
          <div className="mt-1 flex gap-3">
            <textarea
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder="Supports **bold**, *italic*, `code`, [links](url)..."
              className="block min-w-0 flex-1 rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed/50 font-mono resize-y"
            />
            <div className="shrink-0">
              <div className="text-[10px] font-medium text-text-dimmed/60 uppercase tracking-wider mb-1">
                Preview
              </div>
              <div className="w-56">
                <NotificationPreviewCard
                  title={title || "Notification title"}
                  description={description || "Description preview will appear here..."}
                  actionUrl={actionUrl || undefined}
                  image={image || undefined}
                />
              </div>
            </div>
          </div>
        ) : (
          <textarea
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="Plain text description..."
            className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed/50 font-mono resize-y"
          />
        )}
      </div>

      {surface === "WEBAPP" ? (
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="text-xs font-medium text-text-dimmed">Action URL (optional)</label>
            <Input
              name="actionUrl"
              variant="medium"
              fullWidth
              placeholder="https://..."
              value={actionUrl}
              onChange={(e) => setActionUrl(e.target.value)}
              className="mt-1"
            />
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-xs text-text-dimmed whitespace-nowrap">
            <input
              type="checkbox"
              name="dismissOnAction"
              value="true"
              defaultChecked={n?.payloadDismissOnAction ?? false}
              className="rounded border-grid-dimmed bg-charcoal-900"
            />
            Dismiss on action click
          </label>
        </div>
      ) : (
        <div>
          <label className="text-xs font-medium text-text-dimmed">Action URL (optional)</label>
          <Input
            name="actionUrl"
            variant="medium"
            fullWidth
            placeholder="https://..."
            value={actionUrl}
            onChange={(e) => setActionUrl(e.target.value)}
            className="mt-1"
          />
        </div>
      )}

      {surface === "WEBAPP" && (
        <div>
          <label className="text-xs font-medium text-text-dimmed">Image URL (optional)</label>
          <Input
            name="image"
            variant="medium"
            fullWidth
            placeholder="https://example.com/image.png"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            className="mt-1"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-text-dimmed">Starts At (UTC)</label>
          <input
            name="startsAt"
            type="datetime-local"
            defaultValue={n?.startsAt ? toDatetimeLocalUTC(new Date(n.startsAt)) : defaultStartsAt()}
            className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-text-dimmed">Ends At (UTC)</label>
          <input
            name="endsAt"
            type="datetime-local"
            defaultValue={n?.endsAt ? toDatetimeLocalUTC(new Date(n.endsAt)) : defaultEndsAt()}
            className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
            required
          />
        </div>
      </div>

      {surface === "CLI" && (
        <>
          <div className="grid grid-cols-3 gap-3 rounded border border-grid-dimmed bg-charcoal-900 p-3">
            <div>
              <label className="text-xs font-medium text-text-dimmed">Max Show Count</label>
              <Input
                name="cliMaxShowCount"
                variant="medium"
                fullWidth
                type="number"
                defaultValue={n?.cliMaxShowCount != null ? String(n.cliMaxShowCount) : ""}
                placeholder="e.g. 5"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-dimmed">
                Max Days After First Seen
              </label>
              <Input
                name="cliMaxDaysAfterFirstSeen"
                variant="medium"
                fullWidth
                type="number"
                defaultValue={n?.cliMaxDaysAfterFirstSeen != null ? String(n.cliMaxDaysAfterFirstSeen) : ""}
                placeholder="e.g. 7"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-dimmed">Show Every (Nth)</label>
              <Input
                name="cliShowEvery"
                variant="medium"
                fullWidth
                type="number"
                defaultValue={n?.cliShowEvery != null ? String(n.cliShowEvery) : ""}
                placeholder="e.g. 3"
                className="mt-1"
              />
            </div>
          </div>

          <div className="rounded border border-grid-dimmed bg-charcoal-900 p-3 space-y-3">
            <div className="text-xs font-medium text-text-dimmed">
              Discovery (optional) — only show notification if file pattern matches
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-text-dimmed">File Patterns</label>
                <Input
                  name="discoveryFilePatterns"
                  variant="medium"
                  fullWidth
                  defaultValue={n?.payloadDiscovery?.filePatterns.join(", ") ?? ""}
                  placeholder="trigger.config.ts, trigger.config.js"
                  className="mt-1"
                />
                <span className="text-[10px] text-text-dimmed/60">Comma-separated</span>
              </div>
              <div>
                <label className="text-xs font-medium text-text-dimmed">Content Pattern</label>
                <Input
                  name="discoveryContentPattern"
                  variant="medium"
                  fullWidth
                  defaultValue={n?.payloadDiscovery?.contentPattern ?? ""}
                  placeholder="e.g. syncVercelEnvVars"
                  className="mt-1"
                />
                <span className="text-[10px] text-text-dimmed/60">Regex (optional)</span>
              </div>
              <div>
                <label className="text-xs font-medium text-text-dimmed">Match Behavior</label>
                <select
                  name="discoveryMatchBehavior"
                  defaultValue={n?.payloadDiscovery?.matchBehavior ?? ""}
                  className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                >
                  <option value="">— none —</option>
                  <option value="show-if-found">show-if-found</option>
                  <option value="show-if-not-found">show-if-not-found</option>
                </select>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        {isEdit ? (
          <Button
            type="submit"
            variant="primary/small"
            disabled={fetcher.state !== "idle"}
          >
            {fetcher.state !== "idle" ? "Saving..." : "Save Changes"}
          </Button>
        ) : (
          <>
            <Button
              type="submit"
              name="_action"
              value="create"
              variant="primary/small"
              disabled={fetcher.state !== "idle"}
            >
              {fetcher.state !== "idle" ? "Creating..." : "Create"}
            </Button>
            <Button
              type="submit"
              name="_action"
              value="create-preview"
              variant="tertiary/small"
              disabled={fetcher.state !== "idle"}
            >
              Send Preview to Me
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="tertiary/small"
          onClick={onClose}
        >
          Cancel
        </Button>
        {fetcher.data?.error && (
          <span className="text-xs text-red-400">{fetcher.data.error}</span>
        )}
        {!isEdit && fetcher.data?.success && !fetcher.data.previewId && (
          <span className="text-xs text-green-400">Created successfully</span>
        )}
        {!isEdit && fetcher.data?.previewId && (
          <span className="text-xs text-green-400">
            Preview sent (ID: {fetcher.data.previewId})
          </span>
        )}
      </div>
    </fetcher.Form>
  );
}

function NotificationDetailContent({
  notification: n,
}: {
  notification: {
    id: string;
    friendlyId: string;
    surface: string;
    scope: string;
    priority: number;
    startsAt: Date;
    endsAt: Date;
    archivedAt: Date | null;
    createdAt: Date;
    payloadTitle: string | null;
    payloadType: string | null;
    payloadDescription: string | null;
    payloadActionUrl: string | null | undefined;
    payloadImage: string | null | undefined;
    cliMaxShowCount: number | null;
    cliMaxDaysAfterFirstSeen: number | null;
    cliShowEvery: number | null;
    stats: { seen: number; clicked: number; dismissed: number };
  };
}) {
  return (
    <div className="space-y-4">
      {/* Preview */}
      {n.payloadTitle && n.payloadDescription && (
        <div>
          <p className="mb-1 text-xs font-medium text-text-dimmed">Preview</p>
          {n.surface === "WEBAPP" ? (
            <NotificationPreviewCard
              title={n.payloadTitle}
              description={n.payloadDescription}
              actionUrl={n.payloadActionUrl ?? undefined}
              image={n.payloadImage ?? undefined}
            />
          ) : (
            <div className="rounded border border-grid-dimmed bg-charcoal-900 p-3 font-mono text-xs leading-relaxed">
              <p className="font-bold text-text-bright">
                <CliColorMarkup text={n.payloadTitle} fallbackClass="text-text-bright" />
              </p>
              <p className="text-text-dimmed">
                <CliColorMarkup text={n.payloadDescription} fallbackClass="text-text-dimmed" />
              </p>
              {n.payloadActionUrl && (
                <p className="text-text-dimmed underline">{n.payloadActionUrl}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <DetailRow label="ID" value={n.friendlyId} />
        <DetailRow label="Surface" value={n.surface} />
        <DetailRow label="Scope" value={n.scope} />
        <DetailRow label="Type" value={n.payloadType ?? "—"} />
        <DetailRow label="Priority" value={String(n.priority)} />
        <DetailRow label="Created" value={formatDate(n.createdAt)} />
        <DetailRow label="Starts" value={formatDate(n.startsAt)} />
        <DetailRow label="Ends" value={formatDate(n.endsAt)} />
        {n.archivedAt && <DetailRow label="Archived" value={formatDate(n.archivedAt)} />}
        {n.payloadActionUrl && <DetailRow label="Action URL" value={n.payloadActionUrl} />}
      </div>

      {/* CLI settings */}
      {n.surface === "CLI" && (n.cliMaxShowCount || n.cliMaxDaysAfterFirstSeen || n.cliShowEvery) && (
        <div>
          <p className="mb-1 text-xs font-medium text-text-dimmed">CLI Settings</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {n.cliMaxShowCount != null && (
              <DetailRow label="Max show count" value={String(n.cliMaxShowCount)} />
            )}
            {n.cliMaxDaysAfterFirstSeen != null && (
              <DetailRow label="Max days after first seen" value={String(n.cliMaxDaysAfterFirstSeen)} />
            )}
            {n.cliShowEvery != null && (
              <DetailRow label="Show every N-th" value={String(n.cliShowEvery)} />
            )}
          </div>
        </div>
      )}

      {/* Stats */}
      <div>
        <p className="mb-1 text-xs font-medium text-text-dimmed">Stats</p>
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Seen" value={n.stats.seen} />
          <StatCard label="Clicked" value={n.stats.clicked} />
          <StatCard label="Dismissed" value={n.stats.dismissed} />
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-text-dimmed">{label}</span>
      <span className="text-text-bright break-all">{value}</span>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-grid-dimmed bg-charcoal-900 p-2 text-center">
      <p className="text-lg font-mono font-medium text-text-bright">{value}</p>
      <p className="text-xs text-text-dimmed">{label}</p>
    </div>
  );
}

// Mirrors NotificationCard from NotificationPanel.tsx — static preview, no interactions
function NotificationPreviewCard({
  title,
  description,
  actionUrl,
  image,
}: {
  title: string;
  description: string;
  actionUrl?: string;
  image?: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el) {
      setIsOverflowing(el.scrollHeight > el.clientHeight);
    }
  }, [description]);

  const Wrapper = actionUrl ? "a" : "div";
  const wrapperProps = actionUrl
    ? { href: actionUrl, target: "_blank" as const, rel: "noopener noreferrer" as const }
    : {};

  return (
    <Wrapper
      {...wrapperProps}
      className="group/card group relative block overflow-hidden rounded border transition-colors border-grid-bright bg-charcoal-750/50 no-underline"
    >
      <div className="relative flex items-start gap-1 px-2 pt-1.5">
        <Header3 className="flex-1 !text-xs">{title}</Header3>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-text-dimmed transition-colors hover:bg-charcoal-700 hover:text-text-bright"
          tabIndex={-1}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      <div className="relative px-2 pb-2">
        <div className="flex gap-1">
          <div className="min-w-0 flex-1">
            <div ref={descriptionRef} className={cn(!isExpanded && "line-clamp-3")}>
              <ReactMarkdown components={markdownComponents}>{description}</ReactMarkdown>
            </div>
            {(isOverflowing || isExpanded) && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsExpanded((v) => !v);
                }}
                className="mt-0.5 text-xs text-indigo-400 hover:text-indigo-300"
              >
                {isExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
          {actionUrl && (
            <div className="mt-1 flex shrink-0 items-center pb-1 text-text-dimmed group-hover/card:text-text-bright transition-colors">
              <ChevronRightIcon className="size-4" />
            </div>
          )}
        </div>

        {image && (
          <img src={sanitizeImageUrl(image)} alt="" className="mt-1.5 rounded px-2 pb-2" />
        )}
      </div>
    </Wrapper>
  );
}

const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-0.5 text-xs leading-relaxed text-text-dimmed">{children}</p>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-400 underline hover:text-indigo-300 transition-colors"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-text-bright">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-charcoal-700 px-1 py-0.5 text-[11px]">{children}</code>
  ),
};

const CLI_COLOR_MAP: Record<string, string> = {
  red: "text-red-500",
  green: "text-green-500",
  yellow: "text-yellow-500",
  blue: "text-blue-500",
  magenta: "text-fuchsia-500",
  cyan: "text-cyan-500",
  white: "text-white",
  gray: "text-gray-400",
  redBright: "text-red-400",
  greenBright: "text-green-400",
  yellowBright: "text-yellow-400",
  blueBright: "text-blue-400",
  magentaBright: "text-fuchsia-400",
  cyanBright: "text-cyan-400",
  whiteBright: "text-white",
  bold: "font-bold",
};

function CliColorMarkup({ text, fallbackClass }: { text: string; fallbackClass?: string }) {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;

  while (pos < text.length) {
    const braceIdx = text.indexOf("{", pos);
    if (braceIdx === -1) {
      parts.push(text.slice(pos));
      break;
    }

    const closeIdx = text.indexOf("}", braceIdx);
    if (closeIdx === -1) {
      parts.push(text.slice(pos));
      break;
    }

    const tagName = text.slice(braceIdx + 1, closeIdx);
    if (CLI_COLOR_MAP[tagName]) {
      // Found opening tag — look for matching close tag
      const closeTag = `{/${tagName}}`;
      const endIdx = text.indexOf(closeTag, closeIdx + 1);
      if (endIdx !== -1) {
        // Push text before the tag
        if (braceIdx > pos) {
          parts.push(<span key={key++} className={fallbackClass}>{text.slice(pos, braceIdx)}</span>);
        }
        // Push styled content
        parts.push(
          <span key={key++} className={CLI_COLOR_MAP[tagName]}>
            {text.slice(closeIdx + 1, endIdx)}
          </span>
        );
        pos = endIdx + closeTag.length;
        continue;
      }
    }

    // Not a recognized tag — treat as literal
    parts.push(text.slice(pos, closeIdx + 1));
    pos = closeIdx + 1;
  }

  return <>{parts}</>;
}

function Badge({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "amber" | "blue" | "green" | "gray";
}) {
  const colors = {
    amber: "bg-amber-500/20 text-amber-400",
    blue: "bg-blue-500/20 text-blue-400",
    green: "bg-green-500/20 text-green-400",
    gray: "bg-charcoal-700 text-text-dimmed",
  };

  return (
    <span
      className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${colors[color]}`}
    >
      {children}
    </span>
  );
}

function formatDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function toDatetimeLocalUTC(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function defaultStartsAt(): string {
  return toDatetimeLocalUTC(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function defaultEndsAt(): string {
  return toDatetimeLocalUTC(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

/** Sanitize image URL to prevent XSS via javascript: or data: URIs. */
function sanitizeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.href;
    }
    return "";
  } catch {
    return "";
  }
}

type NotificationStatus = "active" | "pending" | "releasing" | "expired" | "archived";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function getNotificationStatus(n: {
  archivedAt: string | Date | null;
  startsAt: string | Date;
  endsAt: string | Date;
}): NotificationStatus {
  if (n.archivedAt) return "archived";
  const now = new Date();
  const starts = typeof n.startsAt === "string" ? new Date(n.startsAt) : n.startsAt;
  const ends = typeof n.endsAt === "string" ? new Date(n.endsAt) : n.endsAt;
  if (now < starts) {
    return starts.getTime() - now.getTime() <= FIVE_MINUTES_MS ? "releasing" : "pending";
  }
  if (now >= ends) return "expired";
  return "active";
}

function StatusBadge({ status }: { status: NotificationStatus }) {
  const styles: Record<NotificationStatus, string> = {
    active: "bg-green-500/20 text-green-400",
    pending: "bg-blue-500/20 text-blue-400",
    releasing: "bg-amber-500/20 text-amber-400",
    expired: "bg-charcoal-700 text-text-dimmed",
    archived: "bg-red-500/20 text-red-400",
  };

  return (
    <span className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

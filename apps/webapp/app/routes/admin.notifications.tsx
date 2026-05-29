import { TrashIcon } from "@heroicons/react/20/solid";
import { useFetcher, useSearchParams } from "@remix-run/react";
import { useEffect, useState } from "react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { Checkbox, CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { NotificationCard } from "~/components/navigation/NotificationCard";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { TextArea } from "~/components/primitives/TextArea";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { logger } from "~/services/logger.server";
import {
  archivePlatformNotification,
  createPlatformNotification,
  deletePlatformNotification,
  getAdminNotificationsList,
  publishNowPlatformNotification,
  updatePlatformNotification,
} from "~/services/platformNotifications.server";
import { createSearchParams } from "~/utils/searchParams";

const PAGE_SIZE = 20;

const WEBAPP_TYPES = ["card", "changelog"] as const;
const CLI_TYPES = ["info", "warn", "error", "success"] as const;

/** Sentinel for the discovery "match behavior" select meaning "none / not configured". */
const DISCOVERY_MATCH_NONE = "";
const DISCOVERY_MATCH_LABEL = "— none —";

const SearchParams = z.object({
  page: z.coerce.number().optional(),
  hideInactive: z.coerce.boolean().optional(),
});

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ user, request }) => {
    const searchParams = createSearchParams(request.url, SearchParams);
    if (!searchParams.success) throw new Error(searchParams.error);
    const { page: rawPage, hideInactive } = searchParams.params.getAll();
    const page = rawPage ?? 1;

    const data = await getAdminNotificationsList({
      page,
      pageSize: PAGE_SIZE,
      hideInactive: hideInactive ?? false,
    });

    return typedjson({ ...data, userId: user.id });
  }
);

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ user, request }) => {
    const userId = user.id;
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
);

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
  const discoveryContentPattern = (formData.get("discoveryContentPattern") as string) || undefined;
  const discoveryMatchBehavior =
    (formData.get("discoveryMatchBehavior") as string) || DISCOVERY_MATCH_NONE;

  const discovery =
    discoveryFilePatterns && discoveryMatchBehavior !== DISCOVERY_MATCH_NONE
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

  if (
    !fields.adminLabel ||
    !fields.title ||
    !fields.description ||
    !fields.endsAt ||
    !fields.surface ||
    !fields.payloadType
  ) {
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
          ...(fields.scope === "ORGANIZATION" && fields.scopeOrganizationId
            ? { organizationId: fields.scopeOrganizationId }
            : {}),
          ...(fields.scope === "PROJECT" && fields.scopeProjectId
            ? { projectId: fields.scopeProjectId }
            : {}),
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
    return typedjson({ error: "Something went wrong, please try again." }, { status: 500 });
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
    return typedjson(
      { error: "Failed to archive notification, please try again." },
      { status: 500 }
    );
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
    return typedjson(
      { error: "Failed to delete notification, please try again." },
      { status: 500 }
    );
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
    return typedjson(
      { error: "Failed to publish notification, please try again." },
      { status: 500 }
    );
  }
}

async function handleEditAction(formData: FormData) {
  const notificationId = formData.get("notificationId") as string;
  const fields = parseNotificationFormData(formData);

  if (
    !notificationId ||
    !fields.adminLabel ||
    !fields.title ||
    !fields.description ||
    !fields.endsAt ||
    !fields.surface ||
    !fields.payloadType ||
    !fields.startsAt
  ) {
    return typedjson({ error: "Missing required fields" }, { status: 400 });
  }

  const result = await updatePlatformNotification({
    id: notificationId,
    title: fields.adminLabel,
    payload: buildPayloadInput(fields),
    surface: fields.surface as "CLI" | "WEBAPP",
    scope: fields.scope as "USER" | "PROJECT" | "ORGANIZATION" | "GLOBAL",
    ...(fields.scope === "USER" && fields.scopeUserId ? { userId: fields.scopeUserId } : {}),
    ...(fields.scope === "ORGANIZATION" && fields.scopeOrganizationId
      ? { organizationId: fields.scopeOrganizationId }
      : {}),
    ...(fields.scope === "PROJECT" && fields.scopeProjectId
      ? { projectId: fields.scopeProjectId }
      : {}),
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
    return typedjson({ error: "Something went wrong, please try again." }, { status: 500 });
  }

  return typedjson({ success: true, id: result.value.id });
}

export default function AdminNotificationsRoute() {
  const { notifications, total, page, pageCount } = useTypedLoaderData<typeof loader>();
  const [showCreate, setShowCreate] = useState(false);
  const [detailNotification, setDetailNotification] = useState<
    (typeof notifications)[number] | null
  >(null);
  const [editNotification, setEditNotification] = useState<(typeof notifications)[number] | null>(
    null
  );

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
            Create notification
          </Button>
        </div>

        <Dialog
          open={showCreate}
          onOpenChange={(open) => {
            if (!open) setShowCreate(false);
          }}
        >
          <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create notification</DialogTitle>
            </DialogHeader>
            <NotificationForm key="create" mode="create" onClose={() => setShowCreate(false)} />
          </DialogContent>
        </Dialog>

        <div className="flex items-center justify-between">
          <Paragraph className="text-text-dimmed">
            {total} notifications (page {page} of {pageCount || 1})
          </Paragraph>
          <label className="flex items-center gap-2 text-xs text-text-dimmed">
            <Checkbox checked={hideInactive} onChange={toggleHideInactive} />
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
                        className="text-left text-sm font-medium text-text-bright transition-colors hover:text-indigo-400"
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
                      <span className="font-mono text-xs">{n.stats.seen}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{n.stats.clicked}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{n.stats.dismissed}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
                        {status === "pending" && <PublishNowButton notificationId={n.id} />}
                        {(status === "pending" ||
                          status === "releasing" ||
                          status === "active") && (
                          <Button variant="tertiary/small" onClick={() => setEditNotification(n)}>
                            Edit
                          </Button>
                        )}
                        {status !== "archived" && <ArchiveButton notificationId={n.id} />}
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
        <DialogContent className="max-w-2xl">
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
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {editNotification && (
            <>
              <DialogHeader>
                <DialogTitle>Edit notification</DialogTitle>
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
        <Button variant="secondary/small">Publish now</Button>
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
            This will permanently delete this notification and all its interaction data. This action
            cannot be undone.
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
  const [surface, setSurface] = useState<"CLI" | "WEBAPP">(
    (n?.surface as "CLI" | "WEBAPP") ?? "WEBAPP"
  );
  const [payloadType, setPayloadType] = useState<string>(n?.payloadType ?? "card");
  const [scope, setScope] = useState<string>(n?.scope ?? "GLOBAL");
  const [title, setTitle] = useState(n?.payloadTitle ?? "");
  const [description, setDescription] = useState(n?.payloadDescription ?? "");
  const [actionUrl, setActionUrl] = useState(n?.payloadActionUrl ?? "");
  const [image, setImage] = useState(n?.payloadImage ?? "");
  const [discoveryMatchBehavior, setDiscoveryMatchBehavior] = useState<string>(
    n?.payloadDiscovery?.matchBehavior ?? DISCOVERY_MATCH_NONE
  );

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

      <input type="hidden" name="surface" value={surface} />
      <input type="hidden" name="payloadType" value={payloadType} />
      <input type="hidden" name="scope" value={scope} />

      <div>
        <Label variant="small">
          Admin name <span className="text-red-400">*</span>
        </Label>
        <Input
          name="adminLabel"
          variant="medium"
          fullWidth
          defaultValue={n?.title ?? ""}
          placeholder="Internal name for this notification"
          className="mt-1"
        />
      </div>

      <div className="flex gap-3">
        <div className="w-28">
          <Label variant="small">Show in</Label>
          <Select<"CLI" | "WEBAPP", "CLI" | "WEBAPP">
            value={surface}
            setValue={(v) => handleSurfaceChange(v as "CLI" | "WEBAPP")}
            variant="tertiary/medium"
            items={["WEBAPP", "CLI"]}
            text={(v) => v}
            className="mt-1 w-full"
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))
            }
          </Select>
        </div>

        <div className="w-28">
          <Label variant="small">Display as</Label>
          <Select<string, string>
            value={payloadType}
            setValue={setPayloadType}
            variant="tertiary/medium"
            items={[...typeOptions]}
            text={(v) => v}
            className="mt-1 w-full"
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))
            }
          </Select>
        </div>

        <div className="w-20">
          <Label variant="small">Priority</Label>
          <Input
            name="priority"
            variant="medium"
            fullWidth
            defaultValue={String(n?.priority ?? 0)}
            type="number"
            className="mt-1"
          />
        </div>

        <div className="flex-1">
          <Label variant="small">Scope</Label>
          <Select<string, string>
            value={scope}
            setValue={setScope}
            variant="tertiary/medium"
            items={["GLOBAL", "USER", "ORGANIZATION", "PROJECT"]}
            text={(v) => v}
            className="mt-1 w-full"
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))
            }
          </Select>
        </div>
      </div>

      {scope === "USER" && (
        <div>
          <Label variant="small">User ID</Label>
          <Input
            name="scopeUserId"
            variant="medium"
            fullWidth
            defaultValue={n?.userId ?? ""}
            placeholder="User ID"
            className="mt-1"
          />
        </div>
      )}

      {scope === "ORGANIZATION" && (
        <div>
          <Label variant="small">Organization ID</Label>
          <Input
            name="scopeOrganizationId"
            variant="medium"
            fullWidth
            defaultValue={n?.organizationId ?? ""}
            placeholder="Organization ID"
            className="mt-1"
          />
        </div>
      )}

      {scope === "PROJECT" && (
        <div>
          <Label variant="small">Project ID</Label>
          <Input
            name="scopeProjectId"
            variant="medium"
            fullWidth
            defaultValue={n?.projectId ?? ""}
            placeholder="Project ID"
            className="mt-1"
          />
        </div>
      )}

      {/* CLI live preview */}
      {surface === "CLI" && (title || description) && (
        <div>
          <Label variant="small">CLI preview</Label>
          <div className="mt-1 rounded border border-grid-dimmed bg-charcoal-900 p-3 font-mono text-xs leading-relaxed">
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
            {actionUrl && <p className="text-text-dimmed underline">{actionUrl}</p>}
          </div>
        </div>
      )}

      <hr className="-mx-4 border-grid-bright" />

      {surface === "WEBAPP" ? (
        <div className="flex gap-3">
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <Label variant="small">
                Title <span className="text-red-400">*</span>
              </Label>
              <TextArea
                name="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                rows={2}
                placeholder="Notification title"
                className="mt-1"
              />
            </div>
            <div>
              <Label variant="small">
                Description (markdown) <span className="text-red-400">*</span>
              </Label>
              <TextArea
                name="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                placeholder="Supports **bold**, *italic*, `code`, [links](url)..."
                className="mt-1 font-mono"
              />
            </div>
          </div>
          <div className="w-56 shrink-0">
            <Label variant="small">Preview</Label>
            <div className="mt-1">
              <NotificationCard
                title={title || "Notification title"}
                description={description || "Description preview will appear here..."}
                actionUrl={actionUrl || undefined}
                image={image || undefined}
              />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div>
            <Label variant="small">
              Title <span className="text-red-400">*</span>
            </Label>
            <TextArea
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={2}
              placeholder="Notification title"
              className="mt-1 font-mono"
            />
          </div>
          <div>
            <Label variant="small">
              Description <span className="text-red-400">*</span>
            </Label>
            <TextArea
              name="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder="Plain text description..."
              className="mt-1 font-mono"
            />
          </div>
        </>
      )}

      <div>
        <Label variant="small">Action URL</Label>
        <Input
          name="actionUrl"
          variant="medium"
          fullWidth
          placeholder="https://..."
          value={actionUrl}
          onChange={(e) => setActionUrl(e.target.value)}
          className="mt-1"
        />
        {surface === "WEBAPP" && (
          <CheckboxWithLabel
            name="dismissOnAction"
            value="true"
            defaultChecked={n?.payloadDismissOnAction ?? false}
            variant="simple/small"
            label="Dismiss on action click"
            className="mt-2"
          />
        )}
      </div>

      {surface === "WEBAPP" && (
        <div>
          <Label variant="small">Image URL</Label>
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
          <Label variant="small">
            Starts at (UTC) {isEdit && <span className="text-red-400">*</span>}
          </Label>
          <input
            name="startsAt"
            type="datetime-local"
            defaultValue={
              n?.startsAt ? toDatetimeLocalUTC(new Date(n.startsAt)) : defaultStartsAt()
            }
            className="mt-1 block h-8 w-full rounded border border-charcoal-800 bg-charcoal-750 px-2 text-sm text-text-bright transition hover:border-charcoal-600 hover:bg-charcoal-650"
            required={isEdit}
          />
        </div>
        <div>
          <Label variant="small">
            Ends at (UTC) <span className="text-red-400">*</span>
          </Label>
          <input
            name="endsAt"
            type="datetime-local"
            defaultValue={n?.endsAt ? toDatetimeLocalUTC(new Date(n.endsAt)) : defaultEndsAt()}
            className="mt-1 block h-8 w-full rounded border border-charcoal-800 bg-charcoal-750 px-2 text-sm text-text-bright transition hover:border-charcoal-600 hover:bg-charcoal-650"
            required
          />
        </div>
      </div>

      {surface === "CLI" && (
        <>
          <input type="hidden" name="discoveryMatchBehavior" value={discoveryMatchBehavior} />

          <div className="grid grid-cols-3 gap-3 rounded border border-grid-dimmed bg-charcoal-900 p-3">
            <div>
              <Label variant="small">Max show count</Label>
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
              <Label variant="small">Max days after first seen</Label>
              <Input
                name="cliMaxDaysAfterFirstSeen"
                variant="medium"
                fullWidth
                type="number"
                defaultValue={
                  n?.cliMaxDaysAfterFirstSeen != null ? String(n.cliMaxDaysAfterFirstSeen) : ""
                }
                placeholder="e.g. 7"
                className="mt-1"
              />
            </div>
            <div>
              <Label variant="small">Show every (nth)</Label>
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

          <div className="space-y-3 rounded border border-grid-dimmed bg-charcoal-900 p-3">
            <Paragraph variant="small" className="text-text-dimmed">
              Discovery (optional) — only show notification if file pattern matches
            </Paragraph>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label variant="small">File patterns</Label>
                <Input
                  name="discoveryFilePatterns"
                  variant="medium"
                  fullWidth
                  defaultValue={n?.payloadDiscovery?.filePatterns.join(", ") ?? ""}
                  placeholder="trigger.config.ts, trigger.config.js"
                  className="mt-1"
                />
                <Hint>Comma-separated</Hint>
              </div>
              <div>
                <Label variant="small">Content pattern</Label>
                <Input
                  name="discoveryContentPattern"
                  variant="medium"
                  fullWidth
                  defaultValue={n?.payloadDiscovery?.contentPattern ?? ""}
                  placeholder="e.g. syncVercelEnvVars"
                  className="mt-1"
                />
                <Hint>Regex (optional)</Hint>
              </div>
              <div>
                <Label variant="small">Match behavior</Label>
                <Select<string, string>
                  value={discoveryMatchBehavior}
                  setValue={setDiscoveryMatchBehavior}
                  variant="tertiary/medium"
                  items={[DISCOVERY_MATCH_NONE, "show-if-found", "show-if-not-found"]}
                  placeholder={DISCOVERY_MATCH_LABEL}
                  text={(v) => (v === DISCOVERY_MATCH_NONE ? DISCOVERY_MATCH_LABEL : v)}
                  className="mt-1 w-full"
                >
                  {(items) =>
                    items.map((item) => (
                      <SelectItem
                        key={item === DISCOVERY_MATCH_NONE ? "none" : item}
                        value={item}
                      >
                        {item === DISCOVERY_MATCH_NONE ? DISCOVERY_MATCH_LABEL : item}
                      </SelectItem>
                    ))
                  }
                </Select>
              </div>
            </div>
          </div>
        </>
      )}

      <DialogFooter className="items-center">
        <div className="flex items-center gap-3">
          <Button type="button" variant="tertiary/medium" onClick={onClose}>
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

        <div className="flex items-center gap-2">
          {isEdit ? (
            <Button type="submit" variant="primary/medium" disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Saving..." : "Save changes"}
            </Button>
          ) : (
            <>
              <Button
                type="submit"
                name="_action"
                value="create-preview"
                variant="tertiary/medium"
                disabled={fetcher.state !== "idle"}
              >
                Send preview to me
              </Button>
              <Button
                type="submit"
                name="_action"
                value="create"
                variant="primary/medium"
                disabled={fetcher.state !== "idle"}
              >
                {fetcher.state !== "idle" ? "Creating..." : "Create"}
              </Button>
            </>
          )}
        </div>
      </DialogFooter>
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
            <NotificationCard
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
      {n.surface === "CLI" &&
        (n.cliMaxShowCount || n.cliMaxDaysAfterFirstSeen || n.cliShowEvery) && (
          <div>
            <p className="mb-1 text-xs font-medium text-text-dimmed">CLI Settings</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              {n.cliMaxShowCount != null && (
                <DetailRow label="Max show count" value={String(n.cliMaxShowCount)} />
              )}
              {n.cliMaxDaysAfterFirstSeen != null && (
                <DetailRow
                  label="Max days after first seen"
                  value={String(n.cliMaxDaysAfterFirstSeen)}
                />
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
      <span className="break-all text-text-bright">{value}</span>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-grid-dimmed bg-charcoal-900 p-2 text-center">
      <p className="font-mono text-lg font-medium text-text-bright">{value}</p>
      <p className="text-xs text-text-dimmed">{label}</p>
    </div>
  );
}

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
          parts.push(
            <span key={key++} className={fallbackClass}>
              {text.slice(pos, braceIdx)}
            </span>
          );
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
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}`;
}

function defaultStartsAt(): string {
  return toDatetimeLocalUTC(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function defaultEndsAt(): string {
  return toDatetimeLocalUTC(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
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
    <span
      className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

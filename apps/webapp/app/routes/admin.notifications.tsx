import { ChevronRightIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useFetcher, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { useRef, useState, useLayoutEffect } from "react";
import ReactMarkdown from "react-markdown";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
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
import { requireUserId } from "~/services/session.server";
import {
  createPlatformNotification,
  getAdminNotificationsList,
} from "~/services/platformNotifications.server";
import { createSearchParams } from "~/utils/searchParams";
import { cn } from "~/utils/cn";

const PAGE_SIZE = 20;

const WEBAPP_TYPES = ["card", "changelog"] as const;
const CLI_TYPES = ["info", "warn", "error", "success"] as const;

const SearchParams = z.object({
  page: z.coerce.number().optional(),
  hideArchived: z.coerce.boolean().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.admin) throw redirect("/");

  const searchParams = createSearchParams(request.url, SearchParams);
  if (!searchParams.success) throw new Error(searchParams.error);
  const { page: rawPage, hideArchived } = searchParams.params.getAll();
  const page = rawPage ?? 1;

  const data = await getAdminNotificationsList({ page, pageSize: PAGE_SIZE, hideArchived: hideArchived ?? false });

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

  return typedjson({ error: "Unknown action" }, { status: 400 });
}

async function handleCreateAction(formData: FormData, userId: string, isPreview: boolean) {
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

  if (!adminLabel || !title || !description || !endsAt || !surface || !payloadType) {
    return typedjson({ error: "Missing required fields" }, { status: 400 });
  }

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

  const result = await createPlatformNotification({
    title: isPreview ? `[Preview] ${adminLabel}` : adminLabel,
    payload: {
      version: "1" as const,
      data: {
        type: payloadType as "info" | "warn" | "error" | "success" | "card" | "changelog",
        title,
        description,
        ...(actionUrl ? { actionUrl } : {}),
        ...(image ? { image } : {}),
        ...(dismissOnAction ? { dismissOnAction: true } : {}),
        ...(discovery ? { discovery } : {}),
      },
    },
    surface: surface as "CLI" | "WEBAPP",
    scope: isPreview ? "USER" : "GLOBAL",
    ...(isPreview ? { userId } : {}),
    startsAt: isPreview
      ? new Date().toISOString()
      : startsAt
        ? new Date(startsAt + "Z").toISOString()
        : new Date().toISOString(),
    endsAt: isPreview
      ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
      : new Date(endsAt + "Z").toISOString(),
    priority,
    ...(surface === "CLI"
      ? isPreview
        ? { cliMaxShowCount: 1 }
        : {
            cliMaxShowCount,
            cliMaxDaysAfterFirstSeen,
            cliShowEvery,
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
    return typedjson({ error: err.message }, { status: 500 });
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

  await prisma.platformNotification.update({
    where: { id: notificationId },
    data: { archivedAt: new Date() },
  });

  return typedjson({ success: true });
}

export default function AdminNotificationsRoute() {
  const { notifications, total, page, pageCount } = useTypedLoaderData<typeof loader>();
  const [showCreate, setShowCreate] = useState(false);
  const createFetcher = useFetcher<{
    success?: boolean;
    error?: string;
    id?: string;
    previewId?: string;
  }>();
  const archiveFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [surface, setSurface] = useState<"CLI" | "WEBAPP">("WEBAPP");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [actionUrl, setActionUrl] = useState("");
  const [image, setImage] = useState("");
  const [payloadType, setPayloadType] = useState<string>("card");

  const typeOptions = surface === "WEBAPP" ? WEBAPP_TYPES : CLI_TYPES;

  // Reset type when surface changes if current type isn't valid for new surface
  const handleSurfaceChange = (newSurface: "CLI" | "WEBAPP") => {
    setSurface(newSurface);
    const newTypes = newSurface === "WEBAPP" ? WEBAPP_TYPES : CLI_TYPES;
    if (!newTypes.includes(payloadType as any)) {
      setPayloadType(newTypes[0]);
    }
  };

  const [urlSearchParams, setUrlSearchParams] = useSearchParams();
  const hideArchived = urlSearchParams.get("hideArchived") === "true";

  const toggleHideArchived = () => {
    setUrlSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (hideArchived) {
        next.delete("hideArchived");
      } else {
        next.set("hideArchived", "true");
      }
      next.delete("page");
      return next;
    });
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Button variant="primary/small" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Hide form" : "Create Notification"}
          </Button>
        </div>

        {showCreate && (
          <div className="rounded-md border border-grid-dimmed bg-charcoal-800 p-4 space-y-3">
            <createFetcher.Form method="post" className="space-y-3">

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs font-medium text-text-dimmed">Admin Label</label>
                  <Input
                    name="adminLabel"
                    variant="medium"
                    fullWidth
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
                    defaultValue="0"
                    type="number"
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-text-dimmed">Title</label>
                <Input
                  name="title"
                  variant="medium"
                  fullWidth
                  placeholder="Notification title"
                  className="mt-1"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              {/* Description + live preview (webapp only) */}
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

              {/* Action URL + dismiss on action (webapp gets both in one row) */}
              {surface === "WEBAPP" ? (
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-text-dimmed">Action URL (optional)</label>
                    <Input
                      name="actionUrl"
                      variant="medium"
                      fullWidth
                      placeholder="https://..."
                      className="mt-1"
                      value={actionUrl}
                      onChange={(e) => setActionUrl(e.target.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 pb-1.5 text-xs text-text-dimmed whitespace-nowrap">
                    <input
                      type="checkbox"
                      name="dismissOnAction"
                      value="true"
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
                    className="mt-1"
                    value={actionUrl}
                    onChange={(e) => setActionUrl(e.target.value)}
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
                    className="mt-1"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-dimmed">Starts At (UTC)</label>
                  <input
                    name="startsAt"
                    type="datetime-local"
                    defaultValue={defaultStartsAt()}
                    className="mt-1 block w-full rounded-sm border border-grid-dimmed bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-text-dimmed">Ends At (UTC)</label>
                  <input
                    name="endsAt"
                    type="datetime-local"
                    defaultValue={defaultEndsAt()}
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
                        placeholder="e.g. syncVercelEnvVars"
                        className="mt-1"
                      />
                      <span className="text-[10px] text-text-dimmed/60">Regex (optional)</span>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-text-dimmed">Match Behavior</label>
                      <select
                        name="discoveryMatchBehavior"
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
                <Button
                  type="submit"
                  name="_action"
                  value="create"
                  variant="primary/small"
                  disabled={createFetcher.state !== "idle"}
                >
                  {createFetcher.state !== "idle" ? "Creating..." : "Create"}
                </Button>
                <Button
                  type="submit"
                  name="_action"
                  value="create-preview"
                  variant="tertiary/small"
                  disabled={createFetcher.state !== "idle"}
                >
                  Send Preview to Me
                </Button>
                {createFetcher.data?.error && (
                  <span className="text-xs text-red-400">{createFetcher.data.error}</span>
                )}
                {createFetcher.data?.success && !createFetcher.data.previewId && (
                  <span className="text-xs text-green-400">Created successfully</span>
                )}
                {createFetcher.data?.previewId && (
                  <span className="text-xs text-green-400">
                    Preview sent (ID: {createFetcher.data.previewId})
                  </span>
                )}
              </div>
            </createFetcher.Form>
          </div>
        )}

        <div className="flex items-center justify-between">
          <Paragraph className="text-text-dimmed">
            {total} notifications (page {page} of {pageCount || 1})
          </Paragraph>
          <label className="flex items-center gap-2 text-xs text-text-dimmed">
            <input
              type="checkbox"
              checked={hideArchived}
              onChange={toggleHideArchived}
              className="rounded border-grid-dimmed bg-charcoal-900"
            />
            Hide archived
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
              <TableHeaderCell>Actions</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
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
                  <TableRow key={n.id}>
                    <TableCell>
                      <span className="text-sm font-medium text-text-bright">{n.title}</span>
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
                      {isActive && (
                        <archiveFetcher.Form method="post" className="inline">
                          <input type="hidden" name="_action" value="archive" />
                          <input type="hidden" name="notificationId" value={n.id} />
                          <Button
                            type="submit"
                            variant="danger/small"
                            disabled={archiveFetcher.state !== "idle"}
                          >
                            Archive
                          </Button>
                        </archiveFetcher.Form>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={status} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PaginationControls currentPage={page} totalPages={pageCount} />
      </div>
    </main>
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

        {/* lgtm[js/xss-through-dom] React JSX sets src via setAttribute, not raw HTML interpolation — safe from XSS */}
        {image && (
          <img src={image} alt="" className="mt-1.5 rounded px-2 pb-2" />
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

type NotificationStatus = "active" | "pending" | "expired" | "archived";

function getNotificationStatus(n: {
  archivedAt: string | Date | null;
  startsAt: string | Date;
  endsAt: string | Date;
}): NotificationStatus {
  if (n.archivedAt) return "archived";
  const now = new Date();
  const starts = typeof n.startsAt === "string" ? new Date(n.startsAt) : n.startsAt;
  const ends = typeof n.endsAt === "string" ? new Date(n.endsAt) : n.endsAt;
  if (now < starts) return "pending";
  if (now >= ends) return "expired";
  return "active";
}

function StatusBadge({ status }: { status: NotificationStatus }) {
  const styles: Record<NotificationStatus, string> = {
    active: "bg-green-500/20 text-green-400",
    pending: "bg-blue-500/20 text-blue-400",
    expired: "bg-charcoal-700 text-text-dimmed",
    archived: "bg-red-500/20 text-red-400",
  };

  return (
    <span className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

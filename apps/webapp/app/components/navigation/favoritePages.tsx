import { BeakerIcon } from "@heroicons/react/24/outline";
import { IconChartHistogram } from "@tabler/icons-react";
import { useFetcher, useFetchers, useLocation } from "@remix-run/react";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { AIMetricsIcon } from "~/assets/icons/AIMetricsIcon";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { AvatarCircleIcon } from "~/assets/icons/AvatarCircleIcon";
import { BatchesIcon } from "~/assets/icons/BatchesIcon";
import { BellIcon } from "~/assets/icons/BellIcon";
import { Box3DIcon } from "~/assets/icons/Box3DIcon";
import { BugIcon } from "~/assets/icons/BugIcon";
import { ChainLinkIcon } from "~/assets/icons/ChainLinkIcon";
import { ChartArrowIcon } from "~/assets/icons/ChartArrowIcon";
import { ChartBarIcon } from "~/assets/icons/ChartBarIcon";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { CreditCardIcon } from "~/assets/icons/CreditCardIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { DialIcon } from "~/assets/icons/DialIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { FolderOpenIcon } from "~/assets/icons/FolderOpenIcon";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { IDIcon } from "~/assets/icons/IDIcon";
import { IntegrationsIcon } from "~/assets/icons/IntegrationsIcon";
import { KeyIcon } from "~/assets/icons/KeyIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { PadlockIcon } from "~/assets/icons/PadlockIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { RolesIcon } from "~/assets/icons/RolesIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { ShieldIcon } from "~/assets/icons/ShieldIcon";
import { SlackIcon } from "~/assets/icons/SlackIcon";
import { SlidersIcon } from "~/assets/icons/SlidersIcon";
import { StarIcon } from "~/assets/icons/StarIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { UsageIcon } from "~/assets/icons/UsageIcon";
import { UserGroupIcon } from "~/assets/icons/UserGroupIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { useIsImpersonating } from "~/hooks/useOrganizations";
import { useOptionalUser } from "~/hooks/useUser";
import { type FavoritePage } from "~/services/dashboardPreferences.server";
import { RUN_COLUMN_SEARCH_PARAMS } from "../runs/v3/runColumns";
import { type RenderIcon } from "../primitives/Icon";

export const FAVORITES_ACTION_PATH = "/resources/preferences/favorites";

/**
 * Marker search param appended to favorite links. It makes a favorited URL distinct from its
 * plain counterpart, so only the favorite (never the matching main menu item) highlights as
 * active, and the marker identifies WHICH favorite when several share a pathname.
 */
export const FAVORITE_SEARCH_PARAM = "fav";

/**
 * Icons a favorited page can be saved with, keyed by a stable string so preferences never store
 * component references, plus the icon color used when the favorite is the active page and an
 * optional size override for icons drawn without internal padding (brand logos). Unknown keys
 * fall back to the star.
 */
const FAVORITE_PAGE_ICONS: Record<
  string,
  { icon: RenderIcon; activeColor: string; className?: string }
> = {
  tasks: { icon: TasksIcon, activeColor: "text-tasks" },
  // Task detail pages carry their task-type icon, matching TaskTriggerSourceIcon
  "task-standard": { icon: TaskIconSmall, activeColor: "text-tasks" },
  "task-scheduled": { icon: ClockIcon, activeColor: "text-schedules" },
  "task-agent": { icon: CubeSparkleIcon, activeColor: "text-agents" },
  runs: { icon: RunsIcon, activeColor: "text-runs" },
  sessions: { icon: AIChatIcon, activeColor: "text-sessions" },
  webhooks: { icon: WebhookIcon, activeColor: "text-webhooks" },
  prompts: { icon: AIPenIcon, activeColor: "text-aiPrompts" },
  models: { icon: Box3DIcon, activeColor: "text-models" },
  logs: { icon: LogsIcon, activeColor: "text-logs" },
  errors: { icon: BugIcon, activeColor: "text-errors" },
  query: { icon: CodeSquareIcon, activeColor: "text-query" },
  queues: { icon: QueuesIcon, activeColor: "text-queues" },
  dashboards: { icon: ChartBarIcon, activeColor: "text-metrics" },
  "run-metrics": { icon: ChartArrowIcon, activeColor: "text-runs" },
  "ai-metrics": { icon: AIMetricsIcon, activeColor: "text-aiMetrics" },
  "custom-dashboard": { icon: IconChartHistogram, activeColor: "text-text-bright" },
  deployments: { icon: DeploymentsIcon, activeColor: "text-deployments" },
  "environment-variables": { icon: IDIcon, activeColor: "text-environmentVariables" },
  branches: { icon: BranchEnvironmentIconSmall, activeColor: "text-previewBranches" },
  regions: { icon: GlobeLinesIcon, activeColor: "text-regions" },
  waitpoints: { icon: WaitpointTokenIcon, activeColor: "text-sky-500" },
  batches: { icon: BatchesIcon, activeColor: "text-batches" },
  "bulk-actions": { icon: ListCheckedIcon, activeColor: "text-text-bright" },
  apikeys: { icon: KeyIcon, activeColor: "text-text-bright" },
  alerts: { icon: BellIcon, activeColor: "text-text-bright" },
  concurrency: { icon: ConcurrencyIcon, activeColor: "text-text-bright" },
  limits: { icon: DialIcon, activeColor: "text-text-bright" },
  schedules: { icon: ClockIcon, activeColor: "text-schedules" },
  test: { icon: BeakerIcon, activeColor: "text-text-bright" },
  "project-settings": { icon: SlidersIcon, activeColor: "text-text-bright" },
  integrations: { icon: IntegrationsIcon, activeColor: "text-text-bright" },
  // Brand logos have no internal padding, so they render one step smaller (matching the org menu)
  slack: { icon: SlackIcon, activeColor: "text-text-bright", className: "size-4" },
  vercel: { icon: VercelLogo, activeColor: "text-text-bright", className: "size-4" },
  project: { icon: FolderOpenIcon, activeColor: "text-text-bright" },
  "org-settings": { icon: SlidersIcon, activeColor: "text-text-bright" },
  team: { icon: UserGroupIcon, activeColor: "text-text-bright" },
  billing: { icon: CreditCardIcon, activeColor: "text-text-bright" },
  usage: { icon: UsageIcon, activeColor: "text-text-bright" },
  roles: { icon: RolesIcon, activeColor: "text-text-bright" },
  sso: { icon: PadlockIcon, activeColor: "text-text-bright" },
  "private-connections": { icon: ChainLinkIcon, activeColor: "text-text-bright" },
  account: { icon: AvatarCircleIcon, activeColor: "text-text-bright" },
  tokens: { icon: ShieldIcon, activeColor: "text-text-bright" },
  security: { icon: PadlockIcon, activeColor: "text-text-bright" },
  page: { icon: StarIcon, activeColor: "text-text-bright" },
};

export function favoritePageIcon(iconKey: string | undefined): RenderIcon {
  return (iconKey ? FAVORITE_PAGE_ICONS[iconKey]?.icon : undefined) ?? StarIcon;
}

export function favoritePageActiveColor(iconKey: string | undefined): string {
  return (iconKey ? FAVORITE_PAGE_ICONS[iconKey]?.activeColor : undefined) ?? "text-text-bright";
}

/** Size override for favorite icons that need one (see FAVORITE_PAGE_ICONS). */
export function favoritePageIconClassName(iconKey: string | undefined): string | undefined {
  return iconKey ? FAVORITE_PAGE_ICONS[iconKey]?.className : undefined;
}

/** Href for a favorite: its saved URL plus the marker param (see FAVORITE_SEARCH_PARAM). */
export function favoriteLinkTo(favorite: FavoritePage): string {
  const [path, search = ""] = favorite.url.split("?");
  const params = new URLSearchParams(search);
  params.set(FAVORITE_SEARCH_PARAM, favorite.id);
  return `${path}?${params.toString()}`;
}

/** Pagination position params: never part of a favorite's identity (see favoritePageUrl). */
const PAGINATION_PARAMS = ["cursor", "direction", "page"];

/**
 * The canonical URL a favorite saves and matches against: the path and search minus the favorite
 * marker (presentation-only) and the pagination position (cursors go stale, and page N of a view
 * is not a different view). A favorite pins filters and tabs, never a transient page of them.
 */
function favoritePageUrl(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FAVORITE_SEARCH_PARAM);
  for (const param of PAGINATION_PARAMS) {
    params.delete(param);
  }
  const result = params.toString();
  return pathname + (result.length > 0 ? `?${result}` : "");
}

/** favoritePageUrl for an already-joined URL, e.g. a favorite's stored one (which may predate
 * pagination stripping). */
function canonicalFavoriteUrl(url: string): string {
  const [pathname, search = ""] = url.split("?");
  return favoritePageUrl(pathname, search);
}

/**
 * A favorite is active only while the URL is the view it saved: its marker param is present AND
 * the canonical URL still matches. Changing any filter on the page diverges the URL from the
 * favorite, so it deactivates (and the regular menu item takes over) — but paging within the
 * view keeps it active, matching what the favorite pins.
 */
export function isFavoriteActive(
  favorite: FavoritePage,
  pathname: string,
  search: string
): boolean {
  return (
    new URLSearchParams(search).get(FAVORITE_SEARCH_PARAM) === favorite.id &&
    canonicalFavoriteUrl(favorite.url) === favoritePageUrl(pathname, search)
  );
}

/**
 * The id of the favorite driving the current view: the URL's marker param, but only when it
 * belongs to one of the current user's favorites AND the URL still matches that favorite's
 * saved view. A marker from someone else's shared link, a removed favorite's stale link, or a
 * view whose filters have since been changed resolves to undefined, so regular menu
 * highlighting applies.
 */
export function useActiveFavoriteId(): string | undefined {
  const location = useLocation();
  const favorites = useFavorites();

  const marker = new URLSearchParams(location.search).get(FAVORITE_SEARCH_PARAM);
  if (!marker) return undefined;
  const favorite = favorites.find((f) => f.id === marker);
  if (!favorite) return undefined;
  return isFavoriteActive(favorite, location.pathname, location.search) ? marker : undefined;
}

type PageMeta = {
  /** Key into FAVORITE_PAGE_ICONS. */
  icon: string;
  /** The page's name as shown in navigation, e.g. "Queues". */
  name: string;
  /** Singular label-prefix for detail pages, e.g. "Queue" -> "Queue: my-queue". */
  singular?: string;
  /**
   * Entity name taken from the URL, used verbatim as the label. For detail pages whose header
   * title is composed JSX (task/agent pages render an icon + slug), so no plain-text title
   * reaches the star. The icon already conveys the type, so no prefix is added.
   */
  entityName?: string;
};

const ENV_PAGE_META: Record<string, PageMeta> = {
  "": { icon: "tasks", name: "Tasks", singular: "Task" },
  runs: { icon: "runs", name: "Runs", singular: "Run" },
  sessions: { icon: "sessions", name: "Sessions", singular: "Session" },
  webhooks: { icon: "webhooks", name: "Webhook deliveries" },
  prompts: { icon: "prompts", name: "Prompts", singular: "Prompt" },
  models: { icon: "models", name: "Models", singular: "Model" },
  logs: { icon: "logs", name: "Logs" },
  errors: { icon: "errors", name: "Errors", singular: "Error" },
  query: { icon: "query", name: "Query" },
  queues: { icon: "queues", name: "Queues", singular: "Queue" },
  dashboards: { icon: "dashboards", name: "Dashboards", singular: "Dashboard" },
  deployments: { icon: "deployments", name: "Deploys", singular: "Deploy" },
  "environment-variables": { icon: "environment-variables", name: "Environment variables" },
  branches: { icon: "branches", name: "Preview branches", singular: "Branch" },
  regions: { icon: "regions", name: "Regions" },
  waitpoints: { icon: "waitpoints", name: "Waitpoint tokens", singular: "Waitpoint" },
  batches: { icon: "batches", name: "Batches", singular: "Batch" },
  "bulk-actions": { icon: "bulk-actions", name: "Bulk actions", singular: "Bulk action" },
  apikeys: { icon: "apikeys", name: "API keys" },
  alerts: { icon: "alerts", name: "Alerts", singular: "Alert" },
  concurrency: { icon: "concurrency", name: "Concurrency" },
  limits: { icon: "limits", name: "Limits" },
  schedules: { icon: "schedules", name: "Schedules", singular: "Schedule" },
  test: { icon: "test", name: "Test", singular: "Test" },
  // The playground route is the Test page too (its header reads "Test")
  playground: { icon: "test", name: "Test", singular: "Test" },
};

const ORG_SETTINGS_PAGE_META: Record<string, PageMeta> = {
  "": { icon: "org-settings", name: "Organization settings" },
  team: { icon: "team", name: "Team" },
  billing: { icon: "billing", name: "Billing" },
  "billing-limits": { icon: "alerts", name: "Billing alerts" },
  usage: { icon: "usage", name: "Usage" },
  roles: { icon: "roles", name: "Roles" },
  sso: { icon: "sso", name: "SSO" },
  "private-connections": { icon: "private-connections", name: "Private connections" },
  integrations: { icon: "integrations", name: "Integrations" },
  danger: { icon: "org-settings", name: "Danger zone" },
};

const ACCOUNT_PAGE_META: Record<string, PageMeta> = {
  "": { icon: "account", name: "Profile" },
  tokens: { icon: "tokens", name: "Personal Access Tokens" },
  security: { icon: "security", name: "Security" },
};

/** Best-effort icon + name for any dashboard page, derived from its URL shape. */
function resolvePageMeta(pathname: string): PageMeta {
  const envMatch = pathname.match(/^\/orgs\/[^/]+\/projects\/[^/]+\/env\/[^/]+(?:\/([^?]*))?$/);
  if (envMatch) {
    const segments = (envMatch[1] ?? "").split("/").filter(Boolean);
    const first = segments[0] ?? "";
    if (first === "settings") {
      return segments[1] === "integrations"
        ? { icon: "integrations", name: "Integrations" }
        : { icon: "project-settings", name: "Project settings" };
    }
    if (first === "dashboards") {
      // The built-in metric dashboards and custom dashboards have their own identities (and icons)
      if (segments[1] === "overview") return { icon: "run-metrics", name: "Run metrics" };
      if (segments[1] === "llm") return { icon: "ai-metrics", name: "AI metrics" };
      if (segments[1] === "custom") {
        return { icon: "custom-dashboard", name: "Dashboards", singular: "Dashboard" };
      }
    }

    // Task detail: /tasks/{standard|scheduled}/{slug}. The slug is the only place the task name
    // exists (the page header renders it as JSX), so it becomes the label.
    if (first === "tasks" && segments[2]) {
      const slug = decodeURIComponent(segments[2]);
      return segments[1] === "scheduled"
        ? { icon: "task-scheduled", name: "Scheduled task", entityName: slug }
        : { icon: "task-standard", name: "Standard task", entityName: slug };
    }

    // Agent tasks live outside /tasks: /agents/{slug}
    if (first === "agents") {
      return segments[1]
        ? {
            icon: "task-agent",
            name: "Agent task",
            entityName: decodeURIComponent(segments[1]),
          }
        : { icon: "task-agent", name: "Agents" };
    }

    return ENV_PAGE_META[first] ?? { icon: "page", name: "Page" };
  }

  const orgSettingsMatch = pathname.match(/^\/orgs\/[^/]+\/settings(?:\/([^?]*))?$/);
  if (orgSettingsMatch) {
    const segments = (orgSettingsMatch[1] ?? "").split("/").filter(Boolean);
    if (segments[0] === "integrations" && segments[1] === "slack") {
      return { icon: "slack", name: "Slack integration" };
    }
    if (segments[0] === "integrations" && segments[1] === "vercel") {
      return { icon: "vercel", name: "Vercel integration" };
    }
    return ORG_SETTINGS_PAGE_META[segments[0] ?? ""] ?? { icon: "org-settings", name: "Settings" };
  }

  if (/^\/orgs\/[^/]+\/projects\/[^/]+/.test(pathname)) {
    return { icon: "project", name: "Project" };
  }

  if (/^\/orgs\/[^/]+/.test(pathname)) {
    return { icon: "project", name: "Projects" };
  }

  const accountMatch = pathname.match(/^\/account(?:\/([^?]*))?$/);
  if (accountMatch) {
    const segments = (accountMatch[1] ?? "").split("/").filter(Boolean);
    return ACCOUNT_PAGE_META[segments[0] ?? ""] ?? { icon: "account", name: "Account" };
  }

  return { icon: "page", name: "Page" };
}

const MAX_LABEL_LENGTH = 50;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label;
}

/**
 * Short id for a detail page whose last URL segment is a friendly id ("run_cmryyza…05hrqq9n").
 * Uses the same 8-character tail the dashboard tables display, so the label matches what the
 * user sees elsewhere.
 */
function detailIdFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && /^(run|batch|session|deployment|schedule|waitpoint)_[a-z0-9]{8,}$/i.test(last)) {
    return last.slice(-8);
  }
  return undefined;
}

/** Task type filter on the Tasks page (?types=…) becomes the whole favorite name. */
const TASK_TYPE_LABELS: Record<string, string> = {
  AGENT: "Agent tasks",
  STANDARD: "Standard tasks",
  SCHEDULED: "Scheduled tasks",
};

/** "COMPLETED_SUCCESSFULLY" -> "Completed successfully", "history" -> "History". */
function humanizeValue(value: string): string {
  const lowered = value.toLowerCase().replaceAll("_", " ");
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

/** Pagination/UI-state params that never describe what the user filtered. */
const NON_FILTER_PARAMS = [
  FAVORITE_SEARCH_PARAM,
  ...PAGINATION_PARAMS,
  "span",
  // The runs list stores its column layout in the URL; that's presentation, not a filter,
  // so it must not count toward the tally ("Runs: 3 filters" for an unfiltered view).
  ...RUN_COLUMN_SEARCH_PARAMS,
];

/**
 * Summarize a filtered view's search params into a short, selective descriptor for the favorite
 * label ("Completed successfully, last 7d +2"). The best-known filters are named (at most two);
 * everything else only counts toward a "+N" so heavily filtered views stay readable.
 */
function describeFilters(search: string): string | undefined {
  const params = new URLSearchParams(search);
  for (const param of NON_FILTER_PARAMS) {
    params.delete(param);
  }

  const parts: string[] = [];
  const consumed = new Set<string>();

  const take = (key: string, describe: (values: string[]) => string | undefined) => {
    const values = params.getAll(key).filter((value) => value.length > 0);
    if (values.length === 0) return;
    consumed.add(key);
    const described = describe(values);
    if (described) parts.push(described);
  };

  // Priority order: the filters most likely to identify the view come first
  take("statuses", (v) => (v.length === 1 ? humanizeValue(v[0]) : `${v.length} statuses`));
  take("levels", (v) => (v.length === 1 ? humanizeValue(v[0]) : `${v.length} levels`));
  take("tasks", (v) => (v.length === 1 ? v[0] : `${v.length} tasks`));
  take("queues", (v) => (v.length === 1 ? v[0].replace(/^task\//, "") : `${v.length} queues`));
  take("tags", (v) => (v.length === 1 ? v[0] : `${v.length} tags`));
  take("period", (v) => `last ${v[0]}`);
  if (params.has("from") || params.has("to")) {
    consumed.add("from");
    consumed.add("to");
    parts.push("custom range");
  }
  take("versions", (v) => (v.length === 1 ? v[0] : `${v.length} versions`));
  take("machines", (v) => (v.length === 1 ? v[0] : `${v.length} machines`));
  take("tab", (v) => humanizeValue(v[0]));
  // The runs list appends rootOnly=false by default; only the non-default value is a filter
  take("rootOnly", (v) => (v[0] === "true" ? "root only" : undefined));

  const remaining = new Set([...params.keys()].filter((key) => !consumed.has(key))).size;

  const MAX_NAMED_PARTS = 2;
  const shown = parts.slice(0, MAX_NAMED_PARTS);
  const extra = parts.length - shown.length + remaining;

  if (shown.length === 0) {
    return extra > 0 ? `${extra} filter${extra === 1 ? "" : "s"}` : undefined;
  }
  return shown.join(", ") + (extra > 0 ? ` +${extra}` : "");
}

/**
 * Compose the default side menu label for a favorited page. Plain list pages keep their nav
 * name ("Queues"); detail pages get an identifying prefix ("Queue: email-queue", or the short
 * id for friendly-id pages: "Run: 05hrqq9n"); filtered views summarize their filters ("Runs:
 * Completed successfully, last 7d"). Users can always rename.
 */
function buildFavoriteLabel(
  pathname: string,
  search: string,
  pageTitle: string | undefined
): string {
  const meta = resolvePageMeta(pathname);
  const title = pageTitle?.trim();
  const prefix = meta.singular ?? meta.name;

  // Generic titles ("Runs", "Run") identify nothing on their own; prefer ids/filters from the URL
  const isGenericTitle =
    !title ||
    title.toLowerCase() === meta.name.toLowerCase() ||
    title.toLowerCase() === prefix.toLowerCase();

  if (isGenericTitle) {
    // Named entity from the URL (task/agent slug) is the label on its own; its icon carries the type
    if (meta.entityName) return truncateLabel(meta.entityName);

    // The Tasks page filtered to a single task type takes that type as the whole name
    if (meta.icon === "tasks") {
      const types = new URLSearchParams(search).getAll("types");
      if (types.length === 1 && TASK_TYPE_LABELS[types[0]]) {
        return TASK_TYPE_LABELS[types[0]];
      }
    }

    const detailId = detailIdFromPath(pathname);
    if (detailId) return `${prefix}: ${detailId}`;

    const filters = describeFilters(search);
    return truncateLabel(filters ? `${meta.name}: ${filters}` : meta.name);
  }

  const label = title.toLowerCase().startsWith(prefix.toLowerCase())
    ? title
    : `${prefix}: ${title}`;
  return truncateLabel(label);
}

/**
 * The user's favorited pages with any in-flight mutations applied, so the star button and the
 * side menu section update instantly and stay in sync while the server round-trip completes.
 */
export function useFavorites(): FavoritePage[] {
  const user = useOptionalUser();
  const fetchers = useFetchers();

  let favorites = user?.dashboardPreferences.sideMenu?.favorites ?? [];

  for (const fetcher of fetchers) {
    if (fetcher.formAction !== FAVORITES_ACTION_PATH || !fetcher.formData) continue;

    const intent = fetcher.formData.get("intent");
    const id = fetcher.formData.get("id");
    if (typeof id !== "string") continue;

    switch (intent) {
      case "add": {
        const url = fetcher.formData.get("url");
        const label = fetcher.formData.get("label");
        const icon = fetcher.formData.get("icon");
        if (typeof url !== "string" || typeof label !== "string") break;
        if (!favorites.some((f) => f.url === url)) {
          // Newest favorites go to the top of the section (matches addFavorite server-side)
          favorites = [
            { id, url, label, icon: typeof icon === "string" ? icon : undefined },
            ...favorites,
          ];
        }
        break;
      }
      case "remove": {
        favorites = favorites.filter((f) => f.id !== id);
        break;
      }
      case "rename": {
        const label = fetcher.formData.get("label");
        if (typeof label !== "string") break;
        favorites = favorites.map((f) => (f.id === id ? { ...f, label } : f));
        break;
      }
    }
  }

  return favorites;
}

/**
 * Shared favorite state + toggle for the current page (full URL, including filters and tabs).
 * Backs both the page-header star and the runs list "Save to favorites" menu item, so the two
 * always agree on what counts as favorited and produce identical favorites.
 */
export function useFavoritePageToggle(pageTitle?: string): {
  isFavorited: boolean;
  /** The favorite's custom name once saved, else the label saving would use. */
  pageName: string;
  /** False for logged-out and impersonating sessions, which must not mutate preferences. */
  canFavorite: boolean;
  toggle: () => void;
} {
  const user = useOptionalUser();
  const isImpersonating = useIsImpersonating();
  const location = useLocation();
  const favorites = useFavorites();
  const fetcher = useFetcher();

  const url = favoritePageUrl(location.pathname, location.search);
  const existing = favorites.find((favorite) => canonicalFavoriteUrl(favorite.url) === url);

  const toggle = () => {
    if (existing) {
      fetcher.submit(
        { intent: "remove", id: existing.id },
        { method: "POST", action: FAVORITES_ACTION_PATH }
      );
    } else {
      fetcher.submit(
        {
          intent: "add",
          id: crypto.randomUUID(),
          url,
          label: buildFavoriteLabel(location.pathname, location.search, pageTitle),
          icon: resolvePageMeta(location.pathname).icon,
        },
        { method: "POST", action: FAVORITES_ACTION_PATH }
      );
    }
  };

  return {
    isFavorited: existing !== undefined,
    pageName: existing?.label ?? buildFavoriteLabel(location.pathname, location.search, pageTitle),
    canFavorite: user !== undefined && !isImpersonating,
    toggle,
  };
}

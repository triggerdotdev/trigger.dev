import { BeakerIcon, ClockIcon } from "@heroicons/react/24/outline";
import { useFetchers } from "@remix-run/react";
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
import { useOptionalUser } from "~/hooks/useUser";
import { type FavoritePage } from "~/services/dashboardPreferences.server";
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
 * component references, plus the icon color used when the favorite is the active page. Unknown
 * keys fall back to the star.
 */
const FAVORITE_PAGE_ICONS: Record<string, { icon: RenderIcon; activeColor: string }> = {
  tasks: { icon: TasksIcon, activeColor: "text-tasks" },
  runs: { icon: RunsIcon, activeColor: "text-runs" },
  sessions: { icon: AIChatIcon, activeColor: "text-sessions" },
  prompts: { icon: AIPenIcon, activeColor: "text-aiPrompts" },
  models: { icon: Box3DIcon, activeColor: "text-models" },
  logs: { icon: LogsIcon, activeColor: "text-logs" },
  errors: { icon: BugIcon, activeColor: "text-errors" },
  query: { icon: CodeSquareIcon, activeColor: "text-query" },
  queues: { icon: QueuesIcon, activeColor: "text-queues" },
  dashboards: { icon: ChartBarIcon, activeColor: "text-metrics" },
  "run-metrics": { icon: ChartArrowIcon, activeColor: "text-runs" },
  "ai-metrics": { icon: AIMetricsIcon, activeColor: "text-aiMetrics" },
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
  slack: { icon: SlackIcon, activeColor: "text-text-bright" },
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

/** Href for a favorite: its saved URL plus the marker param (see FAVORITE_SEARCH_PARAM). */
export function favoriteLinkTo(favorite: FavoritePage): string {
  const [path, search = ""] = favorite.url.split("?");
  const params = new URLSearchParams(search);
  params.set(FAVORITE_SEARCH_PARAM, favorite.id);
  return `${path}?${params.toString()}`;
}

/** The current location's search string without the favorite marker, for saving/matching URLs. */
export function stripFavoriteSearchParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FAVORITE_SEARCH_PARAM);
  const result = params.toString();
  return result.length > 0 ? `?${result}` : "";
}

/** A favorite is active when its marker param is in the URL and the pathname still matches. */
export function isFavoriteActive(
  favorite: FavoritePage,
  pathname: string,
  search: string
): boolean {
  const favoritePath = favorite.url.split("?")[0];
  return (
    pathname === favoritePath &&
    new URLSearchParams(search).get(FAVORITE_SEARCH_PARAM) === favorite.id
  );
}

type PageMeta = {
  /** Key into FAVORITE_PAGE_ICONS. */
  icon: string;
  /** The page's name as shown in navigation, e.g. "Queues". */
  name: string;
  /** Singular label-prefix for detail pages, e.g. "Queue" -> "Queue: my-queue". */
  singular?: string;
};

const ENV_PAGE_META: Record<string, PageMeta> = {
  "": { icon: "tasks", name: "Tasks", singular: "Task" },
  runs: { icon: "runs", name: "Runs", singular: "Run" },
  sessions: { icon: "sessions", name: "Sessions", singular: "Session" },
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
export function resolvePageMeta(pathname: string): PageMeta {
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
      // The built-in metric dashboards have their own identities (and icons)
      if (segments[1] === "overview") return { icon: "run-metrics", name: "Run metrics" };
      if (segments[1] === "llm") return { icon: "ai-metrics", name: "AI metrics" };
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
      return { icon: "integrations", name: "Vercel integration" };
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

/**
 * Compose the default side menu label for a favorited page. List pages keep their nav name
 * ("Queues"); detail pages get an identifying prefix ("Queue: email-queue"). Users can rename.
 */
export function buildFavoriteLabel(pathname: string, pageTitle: string | undefined): string {
  const meta = resolvePageMeta(pathname);
  const title = pageTitle?.trim();

  if (!title || title.toLowerCase() === meta.name.toLowerCase()) {
    return meta.name;
  }

  const prefix = meta.singular ?? meta.name;
  const label = title.toLowerCase().startsWith(prefix.toLowerCase())
    ? title
    : `${prefix}: ${title}`;
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label;
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
          favorites = [
            ...favorites,
            { id, url, label, icon: typeof icon === "string" ? icon : undefined },
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

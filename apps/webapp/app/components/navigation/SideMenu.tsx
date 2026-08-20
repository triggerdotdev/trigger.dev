import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import {
  Form,
  useFetcher,
  useLocation,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { LayoutGroup, motion } from "framer-motion";
import {
  type CSSProperties,
  Fragment,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { ArrowLeftRightIcon } from "~/assets/icons/ArrowLeftRightIcon";
import { ArrowRightSquareIcon } from "~/assets/icons/ArrowRightSquareIcon";
import { AvatarCircleIcon } from "~/assets/icons/AvatarCircleIcon";
import { BatchesIcon } from "~/assets/icons/BatchesIcon";
import { BellIcon } from "~/assets/icons/BellIcon";
import { Box3DIcon } from "~/assets/icons/Box3DIcon";
import { BugIcon } from "~/assets/icons/BugIcon";
import { ChainLinkIcon } from "~/assets/icons/ChainLinkIcon";
import { ChartBarIcon } from "~/assets/icons/ChartBarIcon";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { DialIcon } from "~/assets/icons/DialIcon";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { EyeClosedIcon } from "~/assets/icons/EyeClosedIcon";
import { EyeOpenIcon } from "~/assets/icons/EyeOpenIcon";
import { FolderClosedIcon } from "~/assets/icons/FolderClosedIcon";
import { FolderOpenIcon } from "~/assets/icons/FolderOpenIcon";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { HomeIcon } from "~/assets/icons/HomeIcon";
import { IDIcon } from "~/assets/icons/IDIcon";
import { IntegrationsIcon } from "~/assets/icons/IntegrationsIcon";
import { KeyIcon } from "~/assets/icons/KeyIcon";
import { LeftSideMenuCollapsedIcon } from "~/assets/icons/LeftSideMenuCollapsedIcon";
import { LeftSideMenuIcon } from "~/assets/icons/LeftSideMenuIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { ShieldIcon } from "~/assets/icons/ShieldIcon";
import { SidebarCustomizeIcon } from "~/assets/icons/SidebarCustomizeIcon";
import { SlidersIcon } from "~/assets/icons/SlidersIcon";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { UsageIcon } from "~/assets/icons/UsageIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { CreditCardIcon } from "~/assets/icons/CreditCardIcon";
import { UserCrossIcon } from "~/assets/icons/UserCrossIcon";
import { UserGroupIcon } from "~/assets/icons/UserGroupIcon";
import { RolesIcon } from "~/assets/icons/RolesIcon";
import { PadlockIcon } from "~/assets/icons/PadlockIcon";
import { SlackIcon } from "~/assets/icons/SlackIcon";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { Avatar } from "~/components/primitives/Avatar";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import { type MatchedEnvironment } from "~/hooks/useEnvironment";
import { usePageSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { useHasAdminAccess, useIsViewingAsUser } from "~/hooks/useUser";
import { type UserWithDashboardPreferences } from "~/models/user.server";
import {
  useCurrentPlan,
  useIsUsingRbacPlugin,
  useIsUsingSsoPlugin,
} from "~/routes/_app.orgs.$organizationSlug/route";
import { type FeedbackType } from "~/routes/resources.feedback";
import { IncidentStatusPanel, useIncidentStatus } from "~/routes/resources.incidents";
import { cn } from "~/utils/cn";
import {
  accountPath,
  accountSecurityPath,
  personalAccessTokensPath,
  adminPath,
  branchesPath,
  concurrencyPath,
  docsPath,
  limitsPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationRolesPath,
  organizationSettingsPath,
  organizationSlackIntegrationPath,
  organizationSsoPath,
  organizationTeamPath,
  organizationVercelIntegrationPath,
  queryPath,
  regionsPath,
  v3ApiKeysPath,
  v3BatchesPath,
  v3BillingLimitsPath,
  v3BillingPath,
  v3PrivateConnectionsPath,
  v3BulkActionsPath,
  v3DashboardsLandingPath,
  v3DeploymentsPath,
  v3EnvironmentPath,
  v3EnvironmentVariablesPath,
  v3ErrorsPath,
  v3LogsPath,
  v3ModelsPath,
  v3ProjectAlertsPath,
  v3ProjectSettingsGeneralPath,
  v3ProjectSettingsIntegrationsPath,
  v3PromptsPath,
  v3QueuesPath,
  v3RunsPath,
  v3SessionsPath,
  v3UsagePath,
  v3WaitpointTokensPath,
  v3WebhooksPath,
} from "~/utils/pathBuilder";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { ConnectionIcon, DevPresencePanel, useDevPresence } from "../DevPresence";
import { AlphaBadge, NewBadge } from "../FeatureBadges";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import { Dialog, DialogTrigger } from "../primitives/Dialog";
import { type RenderIcon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";
import { Badge } from "../primitives/Badge";
import {
  Popover,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverTrigger,
} from "../primitives/Popover";
import { ShortcutKey } from "../primitives/ShortcutKey";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";
import { ShortcutsAutoOpen } from "../Shortcuts";
import { type FavoritePage } from "~/services/dashboardPreferences.server";
import {
  CustomizeSidebarDialog,
  type CustomizeSidebarSection,
  type SidebarCustomizationPayload,
} from "./CustomizeSidebarDialog";
import { CreateDashboardButton } from "./DashboardDialogs";
import { DashboardList } from "./DashboardList";
import { EnvironmentSelector } from "./EnvironmentSelector";
import {
  FAVORITES_ACTION_PATH,
  favoriteLinkTo,
  favoritePageIcon,
  favoritePageIconClassName,
  useFavorites,
} from "./favoritePages";
import { FavoriteMenuItem } from "./FavoritesSection";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { NotificationPanel } from "./NotificationPanel";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem, SideMenuLabel } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import {
  isItemHidden,
  orderByPreference,
  SIDE_MENU_POPOVER_ITEM_ICON,
  SIDE_MENU_POPOVER_ITEM_LABEL,
  type SideMenuSectionId,
} from "./sideMenuTypes";

/** Get the collapsed state for a specific side menu section from user preferences */
function getSectionCollapsed(
  sideMenu: { collapsedSections?: Record<string, boolean> } | undefined,
  sectionId: SideMenuSectionId
): boolean {
  return sideMenu?.collapsedSections?.[sectionId] ?? false;
}

type SideMenuItemConfig = {
  /** Stable id used for hidden/order preferences; never rename once shipped. */
  id: string;
  name: string;
  icon: RenderIcon;
  activeIconColor: string;
  inactiveIconColor?: string;
  to: string;
  dataAction?: string;
  badge?: ReactNode;
  trailingIconClassName?: string;
  /** Hidden for every user who hasn't set their own preference for this item. */
  defaultHidden?: boolean;
  /** Right-side action (e.g. the + button on Dashboards); only rendered when visible. */
  action?: ReactNode;
  /** Extra content rendered directly after the item (e.g. the dashboards list). */
  after?: ReactNode;
};

type SideMenuSectionConfig = {
  id: SideMenuSectionId;
  title: string;
  items: SideMenuItemConfig[];
};

// Impersonation accent (menu border + "Stop impersonating"). Full class strings so Tailwind's
// static scanner picks them up.
const IMPERSONATION_ACCENT = {
  border: "border-yellow-500/80",
  text: "text-yellow-500/80",
};

// --- Resizable side menu -----------------------------------------------------
// A drag handle on the right edge resizes the menu. Width-driven visuals read two CSS variables
// written to the root each frame (no React re-render, so drags stay smooth):
//   --sm-collapse:      0 (>= default width) → 1 (collapsed)
//   --sm-label-opacity: 1 → 0, a faster fade curve of --sm-collapse

/** Collapsed rail width in px (matches the previous `w-11`). */
const COLLAPSED_WIDTH = 44;
/** The default/again-expanded width in px (matches the previous `w-56`). */
const DEFAULT_WIDTH = 224;
/** The widest the menu can be dragged, in px. */
const MAX_WIDTH = 400;
/** Duration of the collapse/expand/snap animation, in ms. */
const COLLAPSE_ANIM_MS = 200;
/** Fraction of the collapse range over which labels fade to 0 (0.6 = fully faded at 60% collapsed). */
const LABEL_FADE_FRACTION = 0.6;
/**
 * Snap thresholds as collapse progress (0 = default, 1 = collapsed): release at <= threshold springs
 * open, past it collapses. Separate per direction so releasing early continues the gesture.
 */
const COLLAPSE_SNAP_THRESHOLD = 0.25;
const EXPAND_SNAP_THRESHOLD = 0.9;
/** Pointer travel (px) below which a press on the handle counts as a click (toggle), not a drag. */
const DRAG_CLICK_THRESHOLD = 4;

/** Left/right padding of the pinned top section + scroll body, interpolated 10px → 4px by --sm-collapse. */
const SIDE_MENU_PAD_X = `calc(0.625rem - 0.375rem * var(--sm-collapse, 0))`;
/**
 * Scroll-body right padding DURING a transition (settled-open uses the reserved gutter instead).
 * Interpolates from the measured gutter width (seamless handoff) to 4px collapsed; the 8px fallback
 * is only for the first paint before `--sm-sb-gutter` is measured.
 */
const SIDE_MENU_SCROLL_PAD_RIGHT = `calc(var(--sm-sb-gutter, 8px) - (var(--sm-sb-gutter, 8px) - 0.25rem) * var(--sm-collapse, 0))`;
/**
 * Hover chevron: its 16px width follows --sm-label-opacity so an invisible chevron never holds width
 * mid-drag and pushes the row's clip edge into the icon. Opacity stays class-driven (hover-only).
 */
const SIDE_MENU_CHEVRON_STYLE = {
  maxWidth: "calc(var(--sm-label-opacity, 1) * 16px)",
} as const;
/**
 * Selector row label (org/project/env): opacity follows --sm-label-opacity to fade both directions
 * without popping in on drag-open. The generous max-width cap fades the text in place rather than
 * truncating it, but still scales to 0 so an invisible label never holds width and clips the icon.
 */
const SIDE_MENU_SELECTOR_LABEL_STYLE = {
  maxWidth: "calc(var(--sm-label-opacity, 1) * 1000px)",
  opacity: "var(--sm-label-opacity, 1)",
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Collapse progress (0 = at/above default width, 1 = collapsed) for a given px width. */
function widthToProgress(width: number) {
  return clamp((DEFAULT_WIDTH - width) / (DEFAULT_WIDTH - COLLAPSED_WIDTH), 0, 1);
}

/** Label opacity (1 → 0) for a given collapse progress, using the faster fade curve. */
function progressToLabelOpacity(progress: number) {
  return clamp((LABEL_FADE_FRACTION - progress) / LABEL_FADE_FRACTION, 0, 1);
}

/** cubic-bezier(0.4, 0, 0.2, 1) — standard easing for the rAF tween, matching the CSS transitions. */
function easeStandard(t: number) {
  // Solve the bezier for x = t, then return y. Control points: p1 = (0.4, 0), p2 = (0.2, 1).
  const x1 = 0.4;
  const y1 = 0;
  const x2 = 0.2;
  const y2 = 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const sampleDerivativeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  // Newton-Raphson to invert x(u) = t.
  let u = t;
  for (let i = 0; i < 6; i++) {
    const x = sampleX(u) - t;
    const dx = sampleDerivativeX(u);
    if (Math.abs(x) < 1e-4 || Math.abs(dx) < 1e-6) break;
    u -= x / dx;
  }
  return sampleY(clamp(u, 0, 1));
}

type SideMenuUser = Pick<
  UserWithDashboardPreferences,
  "email" | "admin" | "dashboardPreferences"
> & {
  isImpersonating: boolean;
};
export type SideMenuProject = Pick<
  MatchedProject,
  "id" | "name" | "slug" | "version" | "environments" | "engine" | "createdAt"
>;
export type SideMenuEnvironment = MatchedEnvironment;

type SideMenuProps = {
  user: SideMenuUser;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  button?: ReactNode;
  defaultValue?: FeedbackType;
};

export function SideMenu({
  user,
  project,
  environment,
  organization,
  organizations,
}: SideMenuProps) {
  const [isCollapsed, setIsCollapsed] = useState(
    user.dashboardPreferences.sideMenu?.isCollapsed ?? false
  );
  const [isDragging, setIsDragging] = useState(false);
  // True during a click/⌘B/release-snap animation. With isDragging, marks any in-flight transition
  // (the gutter is only reserved once settled — see `showReservedGutter`).
  const [isAnimating, setIsAnimating] = useState(false);
  // Direction of an in-flight drag, for the Free-plan banner slide. A drag that started expanded is a
  // close (the banner tracks it down); one that started collapsed is an open (the banner stays hidden
  // until fully open, then rises). Only meaningful while `isDragging`.
  const [dragStartedCollapsed, setDragStartedCollapsed] = useState(false);

  // --- Resize state (see the module constants above) ---
  const rootRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  // Mirror of `isCollapsed` for the drag handlers (outside React's render cycle; no stale closures).
  const isCollapsedRef = useRef(isCollapsed);
  // Freeze first-paint values so React never fights the imperative width writes after hydration.
  const [initialVisual] = useState(() => {
    const collapsed = user.dashboardPreferences.sideMenu?.isCollapsed ?? false;
    const expandedWidth = clamp(
      user.dashboardPreferences.sideMenu?.width ?? DEFAULT_WIDTH,
      DEFAULT_WIDTH,
      MAX_WIDTH
    );
    const width = collapsed ? COLLAPSED_WIDTH : expandedWidth;
    const progress = collapsed ? 1 : 0;

    return {
      expandedWidth,
      width,
      progress,
      style: {
        width,
        "--sm-collapse": String(progress),
        "--sm-label-opacity": String(progressToLabelOpacity(progress)),
      } as CSSProperties,
    };
  });
  // The last-committed expanded width; animation targets and re-expansion read from here.
  const expandedWidthRef = useRef(initialVisual.expandedWidth);
  const widthRef = useRef(initialVisual.width);
  const progressRef = useRef(initialVisual.progress);
  // Removes an in-flight drag's window listeners (set on pointerdown; cleared on finish/unmount).
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const preferencesFetcher = useFetcher();
  const pendingPreferencesRef = useRef<{
    isCollapsed?: boolean;
    width?: number;
    sectionId?: SideMenuSectionId;
    sectionCollapsed?: boolean;
  }>({});
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentPlan = useCurrentPlan();
  const { isConnected } = useDevPresence();
  const isFreeUser = currentPlan?.v3Subscription?.isPaying === false;
  const isAdmin = useHasAdminAccess();
  const isViewingAsUser = useIsViewingAsUser();
  const { isManagedCloud } = useFeatures();
  const featureFlags = useFeatureFlags();
  const incidentStatus = useIncidentStatus();
  const isV3Project = project.engine === "V1";
  const favorites = useFavorites();
  const [isCustomizeOpen, setCustomizeOpen] = useState(false);
  // Lives here (not in the dialog): the dialog unmounts on close, which would abort a fetcher it
  // owned mid-request.
  const customizationFetcher = useFetcher<{ success: boolean }>();
  const revalidator = useRevalidator();
  // Confirm lifecycle: the dialog stays open (Confirm spinning) until the save response AND the
  // revalidated preferences land, so the side menu is already updated the moment it closes — and
  // a failed or hung save shows as such instead of silently reading as success.
  const [isCustomizeConfirmPending, setCustomizeConfirmPending] = useState(false);
  const [customizeError, setCustomizeError] = useState<string>();
  // The fetcher's data survives across confirms, so only settle once THIS submission has been
  // seen in flight — otherwise a reopened dialog could consume the previous confirm's response.
  const customizeSubmitSeenRef = useRef(false);
  const submitSidebarCustomization = (payload: SidebarCustomizationPayload) => {
    setCustomizeError(undefined);
    setCustomizeConfirmPending(true);
    customizeSubmitSeenRef.current = false;
    customizationFetcher.submit(
      { customization: JSON.stringify(payload) },
      { method: "POST", action: "/resources/preferences/sidemenu" }
    );
  };
  useEffect(() => {
    if (!isCustomizeConfirmPending) return;
    if (customizationFetcher.state !== "idle") {
      customizeSubmitSeenRef.current = true;
      return;
    }
    if (!customizeSubmitSeenRef.current) return; // submit hasn't been picked up yet
    const data = customizationFetcher.data;
    if (!data) {
      // Settled with no response body (e.g. a session-expiry redirect): fail rather than spin
      // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setCustomizeConfirmPending(false);
      setCustomizeError("Couldn't save your changes. Please try again.");
      return;
    }
    if (data.success) {
      // Wait out the post-save revalidation so the menu behind the dialog reflects the changes
      if (revalidator.state !== "idle") return;
      setCustomizeConfirmPending(false);
      setCustomizeOpen(false);
    } else {
      setCustomizeConfirmPending(false);
      setCustomizeError("Couldn't save your changes. Please try again.");
    }
  }, [
    isCustomizeConfirmPending,
    customizationFetcher.state,
    customizationFetcher.data,
    revalidator.state,
  ]);
  // Same ownership rule: removing a favorite optimistically unmounts its menu item (and, for the
  // last favorite, the whole section), which would abort an item-owned fetcher mid-request.
  // Separate fetchers per mutation: fetchers are single-flight, so a shared one would cancel an
  // in-flight rename when a remove follows quickly (or vice versa).
  const removeFavoriteFetcher = useFetcher();
  const renameFavoriteFetcher = useFetcher();
  const removeFavorite = (id: string) => {
    removeFavoriteFetcher.submit(
      { intent: "remove", id },
      { method: "POST", action: FAVORITES_ACTION_PATH }
    );
  };
  const renameFavorite = (id: string, label: string) => {
    renameFavoriteFetcher.submit(
      { intent: "rename", id, label },
      { method: "POST", action: FAVORITES_ACTION_PATH }
    );
  };

  const persistSideMenuPreferences = useCallback(
    (data: {
      isCollapsed?: boolean;
      width?: number;
      sectionId?: SideMenuSectionId;
      sectionCollapsed?: boolean;
    }) => {
      if (user.isImpersonating) return;

      // Merge with any pending changes
      pendingPreferencesRef.current = {
        ...pendingPreferencesRef.current,
        ...data,
      };

      // Clear existing timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Debounce the actual submission by 500ms
      debounceTimeoutRef.current = setTimeout(() => {
        const pending = pendingPreferencesRef.current;
        const formData = new FormData();
        if (pending.isCollapsed !== undefined) {
          formData.append("isCollapsed", String(pending.isCollapsed));
        }
        if (pending.width !== undefined) {
          formData.append("width", String(pending.width));
        }
        if (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined) {
          formData.append("sectionId", pending.sectionId);
          formData.append("sectionCollapsed", String(pending.sectionCollapsed));
        }
        preferencesFetcher.submit(formData, {
          method: "POST",
          action: "/resources/preferences/sidemenu",
        });
        pendingPreferencesRef.current = {};
      }, 500);
    },
    [user.isImpersonating, preferencesFetcher]
  );

  // Flush routine in a ref so the unmount effect can have empty deps. `useFetcher` returns a fresh
  // object each render, so depending on it would fire the cleanup (flushing the debounce) every
  // render — and drags re-render constantly — instead of only on unmount.
  const flushPendingPreferencesRef = useRef<() => void>();
  // oxlint-disable-next-line react/react-compiler -- This ref intentionally coordinates an imperative integration outside React state.
  flushPendingPreferencesRef.current = () => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    if (user.isImpersonating) return;
    const pending = pendingPreferencesRef.current;
    const hasPendingChanges =
      pending.isCollapsed !== undefined ||
      pending.width !== undefined ||
      (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined);
    if (!hasPendingChanges) return;

    const formData = new FormData();
    if (pending.isCollapsed !== undefined) {
      formData.append("isCollapsed", String(pending.isCollapsed));
    }
    if (pending.width !== undefined) {
      formData.append("width", String(pending.width));
    }
    if (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined) {
      formData.append("sectionId", pending.sectionId);
      formData.append("sectionCollapsed", String(pending.sectionCollapsed));
    }
    preferencesFetcher.submit(formData, {
      method: "POST",
      action: "/resources/preferences/sidemenu",
    });
    pendingPreferencesRef.current = {};
  };

  // Flush pending preferences on unmount. Empty deps so cleanup runs only on a real unmount
  // (see flushPendingPreferencesRef).
  useEffect(() => {
    return () => flushPendingPreferencesRef.current?.();
  }, []);

  // Measure the reserved scrollbar-gutter width once and expose it as `--sm-sb-gutter` (the padding
  // hands off to it seamlessly; platform-dependent, so it must be measured). A probe with the same
  // scrollbar classes is measured so the value matches what that styling reserves.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const probe = document.createElement("div");
    probe.className = "scrollbar-gutter-stable scrollbar-thumb-on-hover";
    probe.style.cssText =
      "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow-y:auto;visibility:hidden;";
    document.body.appendChild(probe);
    const gutter = probe.offsetWidth - probe.clientWidth;
    document.body.removeChild(probe);
    if (gutter > 0) el.style.setProperty("--sm-sb-gutter", `${gutter}px`);
  }, []);

  // Write width + collapse vars straight to the DOM (no re-render) so drags stay smooth; all
  // width-driven visuals (labels, headers, padding, dividers) read them.
  const writeVisual = useCallback((width: number, progress: number) => {
    widthRef.current = width;
    progressRef.current = progress;
    const el = rootRef.current;
    if (!el) return;
    el.style.width = `${width}px`;
    el.style.setProperty("--sm-collapse", String(progress));
    el.style.setProperty("--sm-label-opacity", String(progressToLabelOpacity(progress)));
  }, []);

  // Animate width + progress over COLLAPSE_ANIM_MS (toggle button, ⌘B shortcut, release-snap).
  /* oxlint-disable react/react-compiler -- The animation step is local to each callback invocation. */
  const animateTo = useCallback(
    (targetWidth: number, targetProgress: number) => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const startWidth = widthRef.current;
      const startProgress = progressRef.current;
      if (startWidth === targetWidth && startProgress === targetProgress) {
        setIsAnimating(false);
        return;
      }
      setIsAnimating(true);
      const startTime = performance.now();
      const step = (now: number) => {
        const t = clamp((now - startTime) / COLLAPSE_ANIM_MS, 0, 1);
        const eased = easeStandard(t);
        writeVisual(
          startWidth + (targetWidth - startWidth) * eased,
          startProgress + (targetProgress - startProgress) * eased
        );
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          writeVisual(targetWidth, targetProgress);
          setIsAnimating(false);
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [writeVisual]
  );
  /* oxlint-enable react/react-compiler */

  // Collapse/expand to a resting state and remember it.
  const applyCollapsed = useCallback(
    (next: boolean) => {
      isCollapsedRef.current = next;
      setIsCollapsed(next);
      persistSideMenuPreferences({ isCollapsed: next });
      animateTo(next ? COLLAPSED_WIDTH : expandedWidthRef.current, next ? 1 : 0);
    },
    [animateTo, persistSideMenuPreferences]
  );

  const handleToggleCollapsed = useCallback(() => {
    applyCollapsed(!isCollapsedRef.current);
  }, [applyCollapsed]);

  // Drag runs on window-level listeners so releasing anywhere finalizes it. (Pointer capture alone
  // was unreliable: if the browser drops it mid-drag, the release never fires and the menu strands.)
  /* oxlint-disable react/react-compiler -- Drag handlers share invocation-local state and listeners. */
  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Capture just quiets hover states while dragging; the drag doesn't depend on it.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Grabbing the handle interrupts any in-flight collapse/expand; clear the flag so a drag that
      // rests via writeVisual (not animateTo) doesn't strand it true and keep the gutter hidden.
      setIsAnimating(false);
      // Never allow two concurrent drags.
      dragCleanupRef.current?.();

      const drag = {
        startX: e.clientX,
        startWidth: rootRef.current?.getBoundingClientRect().width ?? widthRef.current,
        startedCollapsed: isCollapsedRef.current,
        didDrag: false,
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onCancel);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        dragCleanupRef.current = null;
      };

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - drag.startX;
        if (!drag.didDrag) {
          // Ignore tiny movement so a click still reads as a click (toggle), not a drag.
          if (Math.abs(dx) < DRAG_CLICK_THRESHOLD) return;
          drag.didDrag = true;
          setIsDragging(true);
          setDragStartedCollapsed(drag.startedCollapsed);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "col-resize";
        }
        const width = clamp(drag.startWidth + dx, COLLAPSED_WIDTH, MAX_WIDTH);
        writeVisual(width, widthToProgress(width));
      };

      const onUp = () => {
        cleanup();
        setIsDragging(false);

        // A press with no meaningful drag toggles the menu.
        if (!drag.didDrag) {
          applyCollapsed(!isCollapsedRef.current);
          return;
        }

        const width = widthRef.current;
        // A drag that started collapsed is an opening gesture: flip the snap zone so an early
        // release keeps opening.
        const snapThreshold = drag.startedCollapsed
          ? EXPAND_SNAP_THRESHOLD
          : COLLAPSE_SNAP_THRESHOLD;
        if (width >= DEFAULT_WIDTH) {
          // Rest at the dragged width.
          const rounded = Math.round(width);
          expandedWidthRef.current = rounded;
          isCollapsedRef.current = false;
          setIsCollapsed(false);
          persistSideMenuPreferences({ isCollapsed: false, width: rounded });
          writeVisual(rounded, 0);
        } else if (widthToProgress(width) <= snapThreshold) {
          // Released near the default width — spring back open.
          expandedWidthRef.current = DEFAULT_WIDTH;
          isCollapsedRef.current = false;
          setIsCollapsed(false);
          persistSideMenuPreferences({ isCollapsed: false, width: DEFAULT_WIDTH });
          animateTo(DEFAULT_WIDTH, 0);
        } else {
          // Released deeper in (or over-dragged past min width) — collapse the rest of the way.
          isCollapsedRef.current = true;
          setIsCollapsed(true);
          persistSideMenuPreferences({ isCollapsed: true });
          animateTo(COLLAPSED_WIDTH, 1);
        }
      };

      const onCancel = () => {
        cleanup();
        setIsDragging(false);
        if (!drag.didDrag) return;
        // Settle back to the current resting state.
        animateTo(
          isCollapsedRef.current ? COLLAPSED_WIDTH : expandedWidthRef.current,
          isCollapsedRef.current ? 1 : 0
        );
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
      dragCleanupRef.current = cleanup;
    },
    [animateTo, applyCollapsed, persistSideMenuPreferences, writeVisual]
  );
  /* oxlint-enable react/react-compiler */

  // Keep the drag handlers' collapsed mirror in sync; tear down any in-flight animation/drag on unmount.
  useEffect(() => {
    isCollapsedRef.current = isCollapsed;
  }, [isCollapsed]);
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      dragCleanupRef.current?.();
    };
  }, []);

  /** Generic handler for any collapsible section - just pass the section ID */
  const handleSectionToggle = useCallback(
    (sectionId: SideMenuSectionId) => (collapsed: boolean) => {
      persistSideMenuPreferences({ sectionId, sectionCollapsed: collapsed });
    },
    [persistSideMenuPreferences]
  );

  useShortcutKeys({
    shortcut: { modifiers: ["mod"], key: "b", enabledOnInputElements: true },
    action: handleToggleCollapsed,
  });

  // Reserve the scrollbar gutter only when fully settled open (stops the list shifting as it starts/
  // stops overflowing). Dropped mid-transition so the right padding can animate instead of a fixed
  // gutter snapping away (see SIDE_MENU_SCROLL_PAD_RIGHT).
  const showReservedGutter = !isCollapsed && !isDragging && !isAnimating;

  // Free-plan banner slide (see FreePlanBanner). "tracking" = a close in progress, so the banner
  // follows --sm-collapse down and is gone by the halfway point; "hidden" = collapsed or an open in
  // progress (stays off-screen); "shown" = settled open, so it rises back up. Drag and click/⌘B share
  // this: a click drives --sm-collapse through the same animation, with isAnimating standing in for
  // isDragging and isCollapsed giving the direction.
  const bannerPhase: "shown" | "tracking" | "hidden" = isDragging
    ? dragStartedCollapsed
      ? "hidden"
      : "tracking"
    : isAnimating
      ? isCollapsed
        ? "tracking"
        : "hidden"
      : isCollapsed
        ? "hidden"
        : "shown";

  // The customizable sections (everything except Tasks/Runs/Sessions), in DEFAULT order. The
  // user's saved order/hidden preferences are applied at render below.
  const staticSections: SideMenuSectionConfig[] = [];

  if (isAdmin || featureFlags.hasAiAccess) {
    staticSections.push({
      id: "ai",
      title: "AI",
      items: [
        {
          id: "prompts",
          name: "Prompts",
          icon: AIPenIcon,
          trailingIconClassName: "size-6",
          activeIconColor: "text-aiPrompts",
          to: v3PromptsPath(organization, project, environment),
          dataAction: "prompts",
          badge: <NewBadge />,
        },
        {
          id: "models",
          name: "Models",
          icon: Box3DIcon,
          activeIconColor: "text-models",
          to: v3ModelsPath(organization, project, environment),
          dataAction: "models",
          badge: <NewBadge />,
        },
      ],
    });
  }

  if (isAdmin || featureFlags.hasQueryAccess || featureFlags.hasLogsPageAccess) {
    staticSections.push({
      id: "metrics",
      title: "Observability",
      items: [
        ...(isAdmin || featureFlags.hasLogsPageAccess
          ? [
              {
                id: "logs",
                name: "Logs",
                icon: LogsIcon,
                activeIconColor: "text-logs",
                to: v3LogsPath(organization, project, environment),
                dataAction: "logs",
                badge: <AlphaBadge />,
              } satisfies SideMenuItemConfig,
            ]
          : []),
        ...(isAdmin || featureFlags.hasQueryAccess
          ? [
              {
                id: "errors",
                name: "Errors",
                icon: BugIcon,
                activeIconColor: "text-errors",
                to: v3ErrorsPath(organization, project, environment),
                dataAction: "errors",
              },
              {
                id: "query",
                name: "Query",
                icon: CodeSquareIcon,
                activeIconColor: "text-query",
                to: queryPath(organization, project, environment),
                dataAction: "query",
              },
              {
                id: "queues",
                name: "Queues",
                icon: QueuesIcon,
                activeIconColor: "text-queues",
                to: v3QueuesPath(organization, project, environment),
                dataAction: "queues",
              },
              {
                id: "dashboards",
                name: "Dashboards",
                icon: ChartBarIcon,
                activeIconColor: "text-metrics",
                to: v3DashboardsLandingPath(organization, project, environment),
                dataAction: "dashboards-landing",
                action: (
                  <CreateDashboardButton
                    organization={organization}
                    project={project}
                    environment={environment}
                    isCollapsed={isCollapsed}
                  />
                ),
                after: (
                  <DashboardList
                    organization={organization}
                    project={project}
                    environment={environment}
                    isCollapsed={isCollapsed}
                    user={user}
                  />
                ),
              },
            ]
          : []),
      ],
    });
  }

  staticSections.push({
    id: "deployments",
    title: "Deployments",
    items: [
      {
        id: "deployments",
        name: "Deploys",
        icon: DeploymentsIcon,
        activeIconColor: "text-deployments",
        to: v3DeploymentsPath(organization, project, environment),
        dataAction: "deployments",
      },
      {
        id: "environment-variables",
        name: "Environment variables",
        icon: IDIcon,
        activeIconColor: "text-environmentVariables",
        to: v3EnvironmentVariablesPath(organization, project, environment),
        dataAction: "environment variables",
      },
      {
        id: "preview-branches",
        name: "Preview branches",
        icon: BranchEnvironmentIconSmall,
        activeIconColor: "text-previewBranches",
        to: branchesPath(organization, project, environment),
        dataAction: "preview-branches",
      },
      {
        id: "regions",
        name: "Regions",
        icon: GlobeLinesIcon,
        activeIconColor: "text-regions",
        to: regionsPath(organization, project, environment),
        dataAction: "regions",
      },
    ],
  });

  staticSections.push({
    id: "manage",
    title: "Manage",
    items: [
      {
        id: "waitpoint-tokens",
        name: "Waitpoint tokens",
        icon: WaitpointTokenIcon,
        activeIconColor: "text-sky-500",
        to: v3WaitpointTokensPath(organization, project, environment),
        dataAction: "waitpoint-tokens",
      },
      {
        id: "batches",
        name: "Batches",
        icon: BatchesIcon,
        activeIconColor: "text-batches",
        to: v3BatchesPath(organization, project, environment),
        dataAction: "batches",
      },
      {
        id: "bulk-actions",
        name: "Bulk actions",
        icon: ListCheckedIcon,
        activeIconColor: "text-text-bright",
        to: v3BulkActionsPath(organization, project, environment),
        dataAction: "bulk actions",
      },
      {
        id: "api-keys",
        name: "API keys",
        icon: KeyIcon,
        activeIconColor: "text-text-bright",
        to: v3ApiKeysPath(organization, project, environment),
        dataAction: "api keys",
      },
      {
        id: "alerts",
        name: "Alerts",
        icon: BellIcon,
        activeIconColor: "text-text-bright",
        to: v3ProjectAlertsPath(organization, project, environment),
        dataAction: "alerts",
      },
      ...(isManagedCloud
        ? [
            {
              id: "concurrency",
              name: "Concurrency",
              icon: ConcurrencyIcon,
              activeIconColor: "text-text-bright",
              to: concurrencyPath(organization, project, environment),
              dataAction: "concurrency",
            } satisfies SideMenuItemConfig,
          ]
        : []),
      {
        id: "limits",
        name: "Limits",
        icon: DialIcon,
        activeIconColor: "text-text-bright",
        to: limitsPath(organization, project, environment),
        dataAction: "limits",
      },
      {
        id: "integrations",
        name: "Integrations",
        icon: IntegrationsIcon,
        activeIconColor: "text-text-bright",
        to: v3ProjectSettingsIntegrationsPath(organization, project, environment),
        dataAction: "project-settings-integrations",
      },
    ],
  });

  const sideMenuPrefs = user.dashboardPreferences.sideMenu;

  // Section order: favorites lives above AI by default; the saved preference reorders
  const orderedSectionIds = orderByPreference(
    [{ id: "favorites" as SideMenuSectionId }, ...staticSections.map((s) => ({ id: s.id }))],
    sideMenuPrefs?.sectionOrder
  ).map((s) => s.id);

  // What the "Customize sidebar" modal edits, in default order (Tasks/Runs/Sessions excluded)
  const customizeSections: CustomizeSidebarSection[] = [
    ...(favorites.length > 0
      ? [
          {
            id: "favorites",
            title: "Favorites",
            items: favorites.map((favorite) => ({
              id: favorite.id,
              name: favorite.label,
              icon: favoritePageIcon(favorite.icon),
              iconClassName: favoritePageIconClassName(favorite.icon),
              isFavorite: true,
            })),
          },
        ]
      : []),
    ...staticSections.map((section) => ({
      id: section.id,
      title: section.title,
      items: section.items.map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        defaultHidden: item.defaultHidden,
      })),
    })),
  ];

  // Customizing exists to persist a layout, and preference writes are skipped for impersonated
  // sessions, so don't offer the entry points there at all (same reason the favorite star hides).
  const openCustomize = user.isImpersonating ? undefined : () => setCustomizeOpen(true);
  const sectionHeaderMenu = openCustomize ? (
    <SectionHeaderMenu onCustomize={openCustomize} />
  ) : undefined;

  return (
    <div
      ref={rootRef}
      style={initialVisual.style}
      className={cn(
        "relative h-full border-r bg-background-bright",
        // The accent is the loudest "you are not this user" tell, so "view as user" drops it too —
        // the point of the mode is a dashboard that looks exactly like the user's. The account
        // menu's "Stop impersonating" and the toggle itself stay on raw impersonation, so there is
        // still a way back out (as does the ⌘⌥A shortcut in <GlobalShortcuts>).
        user.isImpersonating && !isViewingAsUser
          ? IMPERSONATION_ACCENT.border
          : "border-grid-bright"
      )}
    >
      <ResizeHandle
        isCollapsed={isCollapsed}
        isDragging={isDragging}
        onPointerDown={onHandlePointerDown}
      />
      <div className="absolute inset-0 grid grid-cols-[100%] grid-rows-[2.5rem_auto_1fr_auto] overflow-hidden">
        <div className="flex min-w-0 items-center overflow-hidden border-b border-transparent px-1 py-1">
          <div className={cn("min-w-0", (isDragging || !isCollapsed) && "flex-1")}>
            <OrgSelector
              organizations={organizations}
              organization={organization}
              isCollapsed={isCollapsed}
              isDragging={isDragging}
              isAdmin={isAdmin}
              isImpersonating={user.isImpersonating}
            />
          </div>
          <CollapsibleElement isDragging={isDragging}>
            <AccountMenu isAdmin={isAdmin} isImpersonating={user.isImpersonating} />
          </CollapsibleElement>
        </div>
        <div
          className="border-b border-grid-bright pb-2.5 pt-1"
          style={{ paddingLeft: SIDE_MENU_PAD_X, paddingRight: SIDE_MENU_PAD_X }}
        >
          <div className="w-full space-y-1">
            <SideMenuHeader title={"Project"} isCollapsed={isCollapsed} collapsedTitle="Proj" />
            <div className="space-y-1">
              <ProjectSelector
                organization={organization}
                project={project}
                environment={environment}
                isCollapsed={isCollapsed}
                isDragging={isDragging}
                className="w-full"
              />
              <div className="flex items-center">
                <EnvironmentSelector
                  organization={organization}
                  project={project}
                  environment={environment}
                  isCollapsed={isCollapsed}
                  isDragging={isDragging}
                  className="min-w-0 flex-1"
                />
                {environment.type === "DEVELOPMENT" && (
                  <CollapsibleElement isDragging={isDragging} className="shrink-0">
                    <Dialog>
                      <TooltipProvider disableHoverableContent={true}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="inline-flex">
                              <DialogTrigger asChild>
                                <Button
                                  variant="minimal/small"
                                  className="aspect-square h-7 p-1"
                                  aria-label={
                                    isConnected === undefined
                                      ? "Dev server connection status"
                                      : isConnected
                                        ? "Dev server connected"
                                        : "Dev server not connected"
                                  }
                                  LeadingIcon={<ConnectionIcon isConnected={isConnected} />}
                                />
                              </DialogTrigger>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="right" className={"text-xs"}>
                            {isConnected === undefined
                              ? "Checking connection…"
                              : isConnected
                                ? "Your dev server is connected"
                                : "Your dev server is not connected"}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <DevPresencePanel isConnected={isConnected} />
                    </Dialog>
                  </CollapsibleElement>
                )}
              </div>
            </div>
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 overflow-y-auto pt-2.5",
            // Reserve the gutter only when settled open; during transitions it's dropped so the
            // right padding below can animate the spacing seamlessly (see SIDE_MENU_SCROLL_PAD_RIGHT).
            showReservedGutter
              ? "scrollbar-gutter-stable scrollbar-thumb-on-hover"
              : "scrollbar-none"
          )}
        >
          <div
            className="mb-6 flex w-full flex-col gap-4 overflow-hidden"
            style={{
              paddingLeft: SIDE_MENU_PAD_X,
              paddingRight: showReservedGutter ? "0px" : SIDE_MENU_SCROLL_PAD_RIGHT,
            }}
          >
            <div className="w-full space-y-0">
              <SideMenuItem
                name="Tasks"
                icon={TasksIcon}
                activeIconColor="text-tasks"
                inactiveIconColor="text-text-dimmed"
                to={v3EnvironmentPath(organization, project, environment)}
                data-action="tasks"
                isCollapsed={isCollapsed}
                yieldActiveToFavorite
              />
              <SideMenuItem
                name="Runs"
                icon={RunsIcon}
                activeIconColor="text-runs"
                inactiveIconColor="text-text-dimmed"
                to={v3RunsPath(organization, project, environment)}
                data-action="runs"
                isCollapsed={isCollapsed}
                yieldActiveToFavorite
              />
              <SideMenuItem
                name="Sessions"
                icon={AIChatIcon}
                activeIconColor="text-sessions"
                inactiveIconColor="text-text-dimmed"
                to={v3SessionsPath(organization, project, environment)}
                data-action="sessions"
                badge={<NewBadge />}
                isCollapsed={isCollapsed}
                yieldActiveToFavorite
              />
              {(user.admin || user.isImpersonating || featureFlags.hasWebhooksAccess) && (
                <SideMenuItem
                  name="Webhooks"
                  icon={WebhookIcon}
                  activeIconColor="text-webhooks"
                  inactiveIconColor="text-text-dimmed"
                  to={v3WebhooksPath(organization, project, environment)}
                  data-action="webhooks"
                  badge={<NewBadge />}
                  isCollapsed={isCollapsed}
                  yieldActiveToFavorite
                />
              )}
            </div>

            {orderedSectionIds.map((sectionId) => {
              if (sectionId === "favorites") {
                if (favorites.length === 0) return null;
                return (
                  <FavoritesSideMenuSection
                    key="favorites"
                    favorites={favorites}
                    hiddenItems={sideMenuPrefs?.hiddenItems}
                    isCollapsed={isCollapsed}
                    initialCollapsed={getSectionCollapsed(sideMenuPrefs, "favorites")}
                    onCollapseToggle={handleSectionToggle("favorites")}
                    headerMenu={sectionHeaderMenu}
                    onCustomize={openCustomize}
                    onRemoveFavorite={removeFavorite}
                    onRenameFavorite={renameFavorite}
                  />
                );
              }

              const section = staticSections.find((s) => s.id === sectionId);
              if (!section) return null;

              return (
                <CustomizableSideMenuSection
                  key={section.id}
                  section={section}
                  itemOrder={sideMenuPrefs?.sectionItemOrder?.[section.id]}
                  hiddenItems={sideMenuPrefs?.hiddenItems}
                  isCollapsed={isCollapsed}
                  initialCollapsed={getSectionCollapsed(sideMenuPrefs, section.id)}
                  onCollapseToggle={handleSectionToggle(section.id)}
                  headerMenu={sectionHeaderMenu}
                  onCustomize={openCustomize}
                />
              );
            })}
          </div>
        </div>
        <div>
          <NotificationPanel
            isCollapsed={isCollapsed}
            hasIncident={incidentStatus.hasIncident}
            organizationId={organization.id}
            projectId={project.id}
          />
          <IncidentStatusPanel
            isCollapsed={isCollapsed}
            title={incidentStatus.title}
            hasIncident={incidentStatus.hasIncident}
            isManagedCloud={incidentStatus.isManagedCloud}
          />
          <V3DeprecationPanel
            isCollapsed={isCollapsed}
            isV3={isV3Project}
            projectCreatedAt={project.createdAt}
            hasIncident={incidentStatus.hasIncident}
            isManagedCloud={incidentStatus.isManagedCloud}
          />
          <motion.div
            layout
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className={cn(
              "flex flex-col gap-1 border-t border-grid-bright p-1",
              isCollapsed && "items-center"
            )}
          >
            <HelpAndAI
              isCollapsed={isCollapsed}
              isDragging={isDragging}
              organizationId={organization.id}
              projectId={project.id}
              onToggleCollapsed={handleToggleCollapsed}
            />
            {isFreeUser && (
              <FreePlanBanner
                to={v3BillingPath(organization)}
                percentage={currentPlan.v3Usage.usagePercentage}
                phase={bannerPhase}
              />
            )}
          </motion.div>
        </div>
      </div>
      <Dialog
        open={isCustomizeOpen}
        onOpenChange={(open) => {
          setCustomizeOpen(open);
          if (!open) {
            // Cancel/ESC during a pending confirm abandons the wait; a still-running save is
            // harmless (the menu revalidates whenever it lands)
            setCustomizeConfirmPending(false);
            setCustomizeError(undefined);
          }
        }}
      >
        {/* Mounted only while open so the modal state re-seeds from current preferences each time */}
        {isCustomizeOpen && (
          <CustomizeSidebarDialog
            sections={customizeSections}
            prefs={{
              sectionOrder: sideMenuPrefs?.sectionOrder,
              hiddenItems: sideMenuPrefs?.hiddenItems,
              sectionItemOrder: sideMenuPrefs?.sectionItemOrder,
            }}
            onConfirm={submitSidebarCustomization}
            isConfirming={isCustomizeConfirmPending}
            confirmError={customizeError}
          />
        )}
      </Dialog>
    </div>
  );
}

/** A section built from {@link SideMenuItemConfig}s with the user's order/hidden prefs applied. */
function CustomizableSideMenuSection({
  section,
  itemOrder,
  hiddenItems,
  isCollapsed,
  initialCollapsed,
  onCollapseToggle,
  headerMenu,
  onCustomize,
}: {
  section: SideMenuSectionConfig;
  itemOrder: string[] | undefined;
  hiddenItems: Record<string, boolean> | undefined;
  isCollapsed: boolean;
  initialCollapsed: boolean;
  onCollapseToggle: (collapsed: boolean) => void;
  headerMenu: ReactNode;
  /** Undefined when customizing isn't offered (impersonated sessions can't persist a layout). */
  onCustomize: (() => void) | undefined;
}) {
  const orderedItems = orderByPreference(section.items, itemOrder);
  const visibleItems = orderedItems.filter((item) => !isItemHidden(item, hiddenItems));
  const moreItems = orderedItems.filter((item) => isItemHidden(item, hiddenItems));

  return (
    <SideMenuSection
      title={section.title}
      isSideMenuCollapsed={isCollapsed}
      itemSpacingClassName="space-y-0"
      initialCollapsed={initialCollapsed}
      onCollapseToggle={onCollapseToggle}
      headerMenu={headerMenu}
    >
      {visibleItems.map((item) => (
        <Fragment key={item.id}>
          <SideMenuItem
            name={item.name}
            icon={item.icon}
            trailingIconClassName={item.trailingIconClassName}
            activeIconColor={item.activeIconColor}
            inactiveIconColor={item.inactiveIconColor ?? "text-text-dimmed"}
            to={item.to}
            data-action={item.dataAction}
            badge={item.badge}
            isCollapsed={isCollapsed}
            action={item.action}
            yieldActiveToFavorite
          />
          {item.after}
        </Fragment>
      ))}
      {moreItems.length > 0 && (
        <SideMenuMoreItem
          items={moreItems.map((item) => ({
            id: item.id,
            name: item.name,
            icon: item.icon,
            to: item.to,
          }))}
          isCollapsed={isCollapsed}
          onCustomize={onCustomize}
        />
      )}
    </SideMenuSection>
  );
}

/** The user's favorited pages; hidden favorites collapse into the trailing "More" item. */
function FavoritesSideMenuSection({
  favorites,
  hiddenItems,
  isCollapsed,
  initialCollapsed,
  onCollapseToggle,
  headerMenu,
  onCustomize,
  onRemoveFavorite,
  onRenameFavorite,
}: {
  favorites: FavoritePage[];
  hiddenItems: Record<string, boolean> | undefined;
  isCollapsed: boolean;
  initialCollapsed: boolean;
  onCollapseToggle: (collapsed: boolean) => void;
  headerMenu: ReactNode;
  /** Undefined when customizing isn't offered (impersonated sessions can't persist a layout). */
  onCustomize: (() => void) | undefined;
  onRemoveFavorite: (id: string) => void;
  onRenameFavorite: (id: string, label: string) => void;
}) {
  const visible = favorites.filter((favorite) => !(hiddenItems?.[favorite.id] ?? false));
  const hidden = favorites.filter((favorite) => hiddenItems?.[favorite.id] ?? false);

  return (
    <SideMenuSection
      title="Favorites"
      isSideMenuCollapsed={isCollapsed}
      itemSpacingClassName="space-y-0"
      initialCollapsed={initialCollapsed}
      onCollapseToggle={onCollapseToggle}
      headerMenu={headerMenu}
    >
      {visible.map((favorite) => (
        <FavoriteMenuItem
          key={favorite.id}
          favorite={favorite}
          isCollapsed={isCollapsed}
          onRemove={onRemoveFavorite}
          onRename={onRenameFavorite}
        />
      ))}
      {hidden.length > 0 && (
        <SideMenuMoreItem
          items={hidden.map((favorite) => ({
            id: favorite.id,
            name: favorite.label,
            icon: favoritePageIcon(favorite.icon),
            iconClassName: favoritePageIconClassName(favorite.icon),
            to: favoriteLinkTo(favorite),
          }))}
          isCollapsed={isCollapsed}
          onCustomize={onCustomize}
        />
      )}
    </SideMenuSection>
  );
}

/**
 * The trailing "More" item of a section: a popover listing that section's hidden items. Only
 * rendered when the section has hidden items.
 */
function SideMenuMoreItem({
  items,
  isCollapsed,
  onCustomize,
}: {
  items: Array<{ id: string; name: string; icon: RenderIcon; iconClassName?: string; to: string }>;
  isCollapsed: boolean;
  /** Undefined when customizing isn't offered (impersonated sessions can't persist a layout). */
  onCustomize: (() => void) | undefined;
}) {
  const [isOpen, setOpen] = useState(false);
  const navigation = useNavigation();

  // Watch search too: navigating to a favorite can change only the search on the same pathname
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setOpen(false);
  }, [navigation.location?.pathname, navigation.location?.search]);

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger className="flex h-8 w-full items-center gap-2 overflow-hidden rounded pl-1.75 pr-2 text-text-dimmed hover:bg-background-hover hover:text-text-bright focus-custom data-[state=open]:bg-background-hover data-[state=open]:text-text-bright">
            <EllipsisHorizontalIcon className="size-5 shrink-0" />
            <SideMenuLabel
              className="min-w-0 flex-1 select-none text-left text-[0.90625rem] font-medium tracking-[-0.01em]"
              style={{ opacity: "var(--sm-label-opacity, 1)" }}
            >
              More
            </SideMenuLabel>
          </PopoverTrigger>
        }
        content="More"
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        asChild
        tabbable
        disableHoverableContent
      />
      <PopoverContent className="min-w-44 p-0" side="right" align="start" sideOffset={4}>
        <div className="flex flex-col gap-1 p-1">
          {items.map((item) => (
            <PopoverMenuItem
              key={item.id}
              to={item.to}
              title={item.name}
              icon={item.icon}
              leadingIconClassName={cn(SIDE_MENU_POPOVER_ITEM_ICON, item.iconClassName)}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          ))}
        </div>
        {/* flex-col blockifies the inline-block menu item, avoiding stray line-box space below */}
        {onCustomize && (
          <div className="flex flex-col border-t border-grid-bright p-1">
            <PopoverMenuItem
              icon={SidebarCustomizeIcon}
              title="Customize sidebar"
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
              onClick={() => {
                setOpen(false);
                onCustomize();
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The ellipsis on section headers (visible on hover) opening the sidebar customization menu. */
function SectionHeaderMenu({ onCustomize }: { onCustomize: () => void }) {
  const [isOpen, setOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverCustomTrigger
        aria-label="Sidebar options"
        className="flex size-4.5 items-center justify-center justify-items-center rounded p-0 text-text-dimmed hover:bg-surface-control hover:text-text-bright"
      >
        <EllipsisHorizontalIcon className="size-3.5" />
      </PopoverCustomTrigger>
      <PopoverContent className="w-fit min-w-max p-0" align="start" sideOffset={4}>
        {/* flex-col blockifies the inline-block menu item, avoiding stray line-box space below */}
        <div className="flex flex-col p-1">
          <PopoverMenuItem
            icon={SidebarCustomizeIcon}
            title="Customize sidebar"
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
            onClick={() => {
              setOpen(false);
              onCustomize();
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function V3DeprecationPanel({
  isCollapsed,
  isV3,
  projectCreatedAt,
  hasIncident,
  isManagedCloud,
}: {
  isCollapsed: boolean;
  isV3: boolean;
  projectCreatedAt: Date;
  hasIncident: boolean;
  isManagedCloud: boolean;
}) {
  // Only show for projects created before v4 was released
  const V4_RELEASE_DATE = new Date("2025-09-01");
  const isLikelyV3 = isV3 && new Date(projectCreatedAt) < V4_RELEASE_DATE;

  if (!isManagedCloud || !isLikelyV3 || hasIncident) {
    return null;
  }

  return (
    <Popover>
      <div className="p-1">
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <V3DeprecationContent />
        </motion.div>

        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? "auto" : 0,
            opacity: isCollapsed ? 1 : 0,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <SimpleTooltip
            button={
              <PopoverTrigger className="flex h-8! w-full items-center justify-center rounded border border-amber-500/30 bg-amber-500/15 transition-colors hover:border-amber-500/50 hover:bg-amber-500/25">
                <ExclamationTriangleIcon className="size-5 text-amber-400" />
              </PopoverTrigger>
            }
            content="v3 is now deprecated"
            side="right"
            sideOffset={8}
            disableHoverableContent
            asChild
          />
        </motion.div>
      </div>
      <PopoverContent side="right" sideOffset={8} align="start" className="w-52 min-w-0! p-0">
        <V3DeprecationContent />
      </PopoverContent>
    </Popover>
  );
}

function V3DeprecationContent() {
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 pt-1.5">
      <div className="flex items-center gap-1 border-b border-amber-500/30 pb-1">
        <ExclamationTriangleIcon className="size-4 text-amber-400" />
        <Paragraph variant="small/bright" className="text-amber-300">
          v3 is now deprecated
        </Paragraph>
      </div>
      <Paragraph variant="extra-small/bright" className="text-amber-300">
        This is a v3 project which is now deprecated so no runs are executing. Upgrade to v4 to
        resume executing runs in this project.
      </Paragraph>
      <LinkButton
        variant="secondary/small"
        to={docsPath("/upgrade-to-v4")}
        target="_blank"
        fullWidth
        TrailingIcon={ArrowTopRightOnSquareIcon}
        trailingIconClassName="text-amber-300"
        className="border-amber-500/30 bg-amber-500/15 hover:border-amber-500/50! hover:bg-amber-500/25!"
      >
        <span className="text-amber-300">Upgrade to v4</span>
      </LinkButton>
    </div>
  );
}

function OrgSelector({
  organization,
  organizations,
  isCollapsed = false,
  isDragging = false,
  isAdmin,
  isImpersonating,
}: {
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  isCollapsed?: boolean;
  /** True while the menu is being drag-resized; keeps the row in its expanded arrangement. */
  isDragging?: boolean;
  /** Account context, only used to render the collapsed-rail "Account" submenu (see below). */
  isAdmin: boolean;
  isImpersonating: boolean;
}) {
  const currentPlan = useCurrentPlan();
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { isManagedCloud } = useFeatures();
  const featureFlags = useFeatureFlags();
  const showSelfServe = useShowSelfServe();
  const isUsingRbacPlugin = useIsUsingRbacPlugin();
  const isUsingSsoPlugin = useIsUsingSsoPlugin();

  const isPaying = currentPlan?.v3Subscription?.isPaying === true;
  const planTitle = currentPlan?.v3Subscription?.plan?.title;

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setOrgMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setOrgMenuOpen(open)} open={isOrgMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-1.75 hover:bg-background-hover focus-custom",
              // Expanded arrangement also applies mid-drag (resting classes flip only on release).
              isDragging || !isCollapsed ? "w-full justify-between pr-1" : "justify-center pr-0.5"
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <Avatar avatar={organization.avatar} size={1.25} orgName={organization.title} />
              <span
                className="flex min-w-0 items-center gap-1.5 overflow-hidden"
                style={SIDE_MENU_SELECTOR_LABEL_STYLE}
              >
                <SideMenuLabel className="text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                  {organization.title}
                </SideMenuLabel>
              </span>
            </span>
            <span
              className="overflow-hidden opacity-0 group-hover:opacity-100"
              style={SIDE_MENU_CHEVRON_STYLE}
            >
              <DropdownIcon className="size-4 min-w-4 text-text-dimmed group-hover:text-text-bright" />
            </span>
          </PopoverTrigger>
        }
        content={organization.title}
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="h-8!"
        asChild
        tabbable
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-64 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
        side={isCollapsed ? "right" : "bottom"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        {!isCollapsed && <PopoverSectionHeader title="Organization" />}
        <div className="flex flex-col gap-1 p-1">
          <PopoverMenuItem
            to={organizationSettingsPath(organization)}
            title="Settings"
            icon={SlidersIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
          {isManagedCloud && (
            <PopoverMenuItem
              to={v3UsagePath(organization)}
              title="Usage"
              icon={UsageIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isManagedCloud && (
            <PopoverMenuItem
              to={v3BillingPath(organization)}
              title={
                <div className="flex w-full items-center justify-between text-text-bright">
                  <span className="grow truncate text-left">Billing</span>
                  {isPaying && planTitle ? <Badge variant="extra-small">{planTitle}</Badge> : null}
                </div>
              }
              icon={CreditCardIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isManagedCloud && showSelfServe && (
            <PopoverMenuItem
              to={v3BillingLimitsPath(organization)}
              title="Billing alerts"
              icon={BellIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          <PopoverMenuItem
            to={organizationTeamPath(organization)}
            title="Team"
            icon={UserGroupIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
          {featureFlags.hasPrivateConnections && (
            <PopoverMenuItem
              to={v3PrivateConnectionsPath(organization)}
              title="Private connections"
              icon={ChainLinkIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isUsingRbacPlugin && (
            <PopoverMenuItem
              to={organizationRolesPath(organization)}
              title="Roles"
              icon={RolesIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          {isUsingSsoPlugin && (
            <PopoverMenuItem
              to={organizationSsoPath(organization)}
              title="SSO"
              icon={PadlockIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
          <Integrations organization={organization} />
        </div>
        <div className="border-t border-grid-bright p-1">
          {organizations.length > 1 ? (
            <SwitchOrganizations organizations={organizations} organization={organization} />
          ) : (
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New organization"
              icon={PlusIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
        </div>
        {/* Collapsed: the account button is hidden, so surface Account as a submenu here (the only
            always-reachable menu on the rail). */}
        {isCollapsed && (
          <div className="border-t border-grid-bright p-1">
            <SideMenuPopoverSubMenu title="Account" icon={<UserProfilePhoto className="size-5" />}>
              <AccountMenuItems isAdmin={isAdmin} isImpersonating={isImpersonating} />
            </SideMenuPopoverSubMenu>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Account menu entries, shared by the standalone account popover (expanded rail) and the "Account"
 * submenu in the org popover (collapsed rail).
 */
function AccountMenuItems({
  isAdmin,
  isImpersonating,
}: {
  isAdmin: boolean;
  isImpersonating: boolean;
}) {
  const submit = useSubmit();
  const stopImpersonating = () =>
    submit(null, { action: "/resources/impersonation", method: "delete" });

  return (
    <>
      {/* "Stop impersonating" and the view-as-user toggle key off raw impersonation, not `isAdmin`:
          with "view as user" on, `isAdmin` is false and these are the only ways back out. */}
      {(isImpersonating || isAdmin) && (
        <div className="flex flex-col gap-1 border-b border-grid-bright p-1">
          {isImpersonating ? (
            <>
              <PopoverMenuItem
                title={
                  <div className="flex w-full items-center justify-between">
                    <span className={IMPERSONATION_ACCENT.text}>Stop impersonating</span>
                    <ShortcutKey
                      shortcut={{ modifiers: ["mod", "alt"], key: "a" }}
                      variant="medium/bright"
                    />
                  </div>
                }
                icon={UserCrossIcon}
                onClick={stopImpersonating}
                leadingIconClassName={cn(SIDE_MENU_POPOVER_ITEM_ICON, IMPERSONATION_ACCENT.text)}
                className={SIDE_MENU_POPOVER_ITEM_LABEL}
              />
              <ViewAsUserMenuItem />
            </>
          ) : (
            <PopoverMenuItem
              to={adminPath()}
              title={
                <div className="flex w-full items-center justify-between">
                  <span>Admin dashboard</span>
                  <ShortcutKey
                    shortcut={{ modifiers: ["mod", "alt"], key: "a" }}
                    variant="medium/bright"
                  />
                </div>
              }
              icon={HomeIcon}
              leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
              className={SIDE_MENU_POPOVER_ITEM_LABEL}
            />
          )}
        </div>
      )}
      <div className="flex flex-col gap-1 p-1">
        <PopoverMenuItem
          to={accountPath()}
          title="Profile"
          icon={AvatarCircleIcon}
          leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
        <PopoverMenuItem
          to={personalAccessTokensPath()}
          title="Personal Access Tokens"
          icon={ShieldIcon}
          leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
        <PopoverMenuItem
          to={accountSecurityPath()}
          title="Security"
          icon={PadlockIcon}
          leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
      </div>
      <div className="border-t border-grid-bright p-1">
        <PopoverMenuItem
          to={logoutPath()}
          title="Logout"
          icon={ArrowRightSquareIcon}
          leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
          danger
        />
      </div>
    </>
  );
}

/**
 * Toggles the display-only "view as user" mode for the current impersonation session, so an admin
 * can see the dashboard the way the impersonated user sees it. `reloadDocument` forces a full
 * navigation, so every loader re-runs under the updated cookie instead of reusing cached data.
 */
function ViewAsUserMenuItem() {
  const isViewingAsUser = useIsViewingAsUser();
  const location = useLocation();

  return (
    <Form method="post" action="/resources/impersonation/view-as" reloadDocument>
      <input type="hidden" name="viewAsUser" value={isViewingAsUser ? "false" : "true"} />
      <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />
      <PopoverMenuItem
        type="submit"
        title={isViewingAsUser ? "Show admin UI" : "View as user"}
        icon={isViewingAsUser ? EyeClosedIcon : EyeOpenIcon}
        leadingIconClassName={cn(SIDE_MENU_POPOVER_ITEM_ICON, IMPERSONATION_ACCENT.text)}
        className={SIDE_MENU_POPOVER_ITEM_LABEL}
      />
    </Form>
  );
}

function AccountMenu({ isAdmin, isImpersonating }: { isAdmin: boolean; isImpersonating: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setIsOpen(false);
  }, [navigation.location?.pathname]);

  // The admin shortcut lives in <GlobalShortcuts> so it works everywhere, not just where this menu is.
  return (
    <Popover onOpenChange={(open) => setIsOpen(open)} open={isOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger className="group flex size-8 items-center justify-center rounded hover:bg-background-hover focus-custom">
            <UserProfilePhoto className="size-5" />
          </PopoverTrigger>
        }
        content="Account"
        side="bottom"
        sideOffset={8}
        asChild
        tabbable
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-64 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
        side="bottom"
        sideOffset={4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <PopoverSectionHeader title="Account" />
        <AccountMenuItems isAdmin={isAdmin} isImpersonating={isImpersonating} />
      </PopoverContent>
    </Popover>
  );
}

function ProjectSelector({
  project,
  organization,
  environment,
  isCollapsed = false,
  isDragging = false,
  className,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
  environment: SideMenuEnvironment;
  isCollapsed?: boolean;
  /** True while the menu is being drag-resized; keeps the row in its expanded arrangement. */
  isDragging?: boolean;
  className?: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { urlForProject } = usePageSwitcher();

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded border pl-1.75 transition-[border-color] duration-150 hover:bg-background-hover focus-custom",
              // Expanded arrangement also applies mid-drag (resting classes flip only on release).
              isDragging || !isCollapsed
                ? "justify-between border-grid-bright pr-1"
                : "justify-center border-transparent pr-0.5",
              className
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <FolderOpenIcon className="size-5 shrink-0 text-text-bright" />
              <span
                className="flex min-w-0 items-center overflow-hidden"
                style={SIDE_MENU_SELECTOR_LABEL_STYLE}
              >
                <SideMenuLabel className="text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                  {project.name ?? "Select a project"}
                </SideMenuLabel>
              </span>
            </span>
            <span
              className="overflow-hidden opacity-0 group-hover:opacity-100"
              style={SIDE_MENU_CHEVRON_STYLE}
            >
              <DropdownIcon className="size-4 min-w-4 text-text-dimmed group-hover:text-text-bright" />
            </span>
          </PopoverTrigger>
        }
        content={project.name ?? "Select a project"}
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="h-8!"
        asChild
        tabbable
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-56 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
        side={isCollapsed ? "right" : "bottom"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-1 p-1">
          <PopoverMenuItem
            to={newProjectPath(organization)}
            title="New project"
            icon={PlusIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
          <PopoverMenuItem
            to={v3ProjectSettingsGeneralPath(organization, project, environment)}
            title="Project settings"
            icon={SlidersIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
          />
        </div>
        <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
          {organization.projects.map((p) => {
            const isSelected = p.id === project.id;
            return (
              <PopoverMenuItem
                key={p.id}
                to={urlForProject(organization, p)}
                title={
                  <div className="flex w-full items-center justify-between text-text-bright">
                    <SideMenuLabel className="min-w-0 grow text-left">{p.name}</SideMenuLabel>
                  </div>
                }
                isSelected={isSelected}
                icon={isSelected ? FolderOpenIcon : FolderClosedIcon}
                leadingIconClassName="h-5 w-5 text-indigo-500"
                className={SIDE_MENU_POPOVER_ITEM_LABEL}
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Hover-expandable submenu row for side-menu popovers (Account, Switch organization, Integrations):
 * a menu item with a trailing chevron that reveals `children` in a popover to the right, with a
 * short close delay so the pointer can cross the gap.
 */
function SideMenuPopoverSubMenu({
  title,
  icon,
  leadingIconClassName,
  children,
}: {
  title: string;
  icon: RenderIcon;
  leadingIconClassName?: string;
  children: ReactNode;
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Close the submenu on navigation (the parent popover closes too).
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setIsOpen(false);
  }, [navigation.location?.pathname]);

  const openNow = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };
  const closeSoon = () => {
    // Small delay before closing so the pointer can move onto the content.
    timeoutRef.current = setTimeout(() => setIsOpen(false), 150);
  };

  return (
    <Popover onOpenChange={(open) => setIsOpen(open)} open={isOpen}>
      <div onMouseEnter={openNow} onMouseLeave={closeSoon} className="flex">
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className={cn("hover:bg-background-hover", SIDE_MENU_POPOVER_ITEM_LABEL)}
            LeadingIcon={icon}
            leadingIconClassName={cn(SIDE_MENU_POPOVER_ITEM_ICON, leadingIconClassName)}
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            {title}
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className="min-w-64 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
        >
          {children}
        </PopoverContent>
      </div>
    </Popover>
  );
}

function SwitchOrganizations({
  organizations,
  organization,
}: {
  organizations: MatchedOrganization[];
  organization: MatchedOrganization;
}) {
  const { urlForOrganization } = usePageSwitcher();

  return (
    <SideMenuPopoverSubMenu title="Switch organization" icon={ArrowLeftRightIcon}>
      <div className="flex flex-col gap-1 p-1">
        <PopoverMenuItem
          to={newOrganizationPath()}
          title="New organization"
          icon={PlusIcon}
          leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        {organizations.map((org) => (
          <PopoverMenuItem
            key={org.id}
            to={urlForOrganization(org)}
            title={org.title}
            icon={<Avatar size={1.25} avatar={org.avatar} orgName={org.title} />}
            leadingIconClassName="text-text-dimmed"
            className={SIDE_MENU_POPOVER_ITEM_LABEL}
            isSelected={org.id === organization.id}
          />
        ))}
      </div>
    </SideMenuPopoverSubMenu>
  );
}

function Integrations({ organization }: { organization: MatchedOrganization }) {
  return (
    <SideMenuPopoverSubMenu title="Integrations" icon={IntegrationsIcon}>
      <div className="flex flex-col gap-1 p-1">
        <PopoverMenuItem
          to={organizationVercelIntegrationPath(organization)}
          title="Vercel"
          icon={VercelLogo}
          leadingIconClassName="size-4 text-text-dimmed"
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
        <PopoverMenuItem
          to={organizationSlackIntegrationPath(organization)}
          title="Slack"
          icon={SlackIcon}
          leadingIconClassName="size-4 text-text-dimmed"
          className={SIDE_MENU_POPOVER_ITEM_LABEL}
        />
      </div>
    </SideMenuPopoverSubMenu>
  );
}

/**
 * Fades out and collapses to 0 width via the menu's `--sm-label-opacity` variable, tracking a drag
 * in real time (no CSS opacity transition — it would lag the per-frame variable writes).
 */
function CollapsibleElement({
  isDragging = false,
  children,
  className,
}: {
  /** Only blocks clicks on the fading button mid-drag; the hiding is width+opacity below. */
  isDragging?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // Width AND opacity follow --sm-label-opacity: opacity alone would leave the invisible button
  // holding 32px of row width, pushing the primary item's clip edge into its icon ("masked" mid-drag).
  // Shrinking width on the same curve hands that space back. No CSS transition (it would lag the writes).
  return (
    <div
      className={cn("overflow-hidden", isDragging && "pointer-events-none", className)}
      style={{
        maxWidth: "calc(var(--sm-label-opacity, 1) * 32px)",
        opacity: "var(--sm-label-opacity, 1)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The Free-plan banner at the foot of the menu. On close it doesn't collapse or slide on its own: its
 * reserved height collapses (tracking --sm-collapse, gone by the halfway point) and, because the bottom
 * section is pinned to the bottom, that pushes the whole section (Help & Feedback + this banner) down so
 * the full-height banner slides off the bottom edge. On open it lags, waiting for the settled "shown"
 * phase, then rises back up via translateY. Height is measured so the reclaimed space matches the banner.
 */
function FreePlanBanner({
  to,
  percentage,
  phase,
}: {
  to: string;
  percentage: number;
  phase: "shown" | "tracking" | "hidden";
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Close progress, doubled + clamped so the banner is fully gone by the time the menu is halfway shut.
  const closeProgress = "min(var(--sm-collapse, 0) * 2, 1)";
  // Slide a little past its own height to clear the section padding + the viewport edge.
  const offset = height + 24;

  const maxHeight =
    phase === "shown"
      ? height
        ? `${height}px`
        : "none"
      : phase === "hidden"
        ? "0px"
        : `calc((1 - ${closeProgress}) * ${height}px)`;
  // On close the banner no longer slides itself: its reserved height collapses (maxHeight) and, because
  // the bottom section is pinned to the bottom, that drops Help & Feedback down while the full-height
  // banner overflows off the bottom edge. Only the pop-up-from-hidden rise uses translateY, so "hidden"
  // parks it below the edge; "shown" and "tracking" both sit at 0.
  const translateY = phase === "hidden" ? `${offset}px` : "0px";
  // Fade out as it slides off (tracking --sm-collapse) and fade back in on the settled-open rise.
  const opacity = phase === "shown" ? 1 : phase === "hidden" ? 0 : `calc(1 - ${closeProgress})`;

  return (
    <div
      style={{
        maxHeight,
        // The full-height banner overflows off the bottom as maxHeight collapses; it isn't clipped.
        overflow: "visible",
        transform: `translateY(${translateY})`,
        opacity,
        // Only the settled-open rise animates; while tracking a drag/close we follow --sm-collapse
        // frame-by-frame (a transition would lag the drag).
        transition:
          phase === "shown"
            ? "max-height 300ms ease, transform 300ms ease, opacity 300ms ease"
            : "none",
      }}
    >
      <div ref={contentRef}>
        <FreePlanUsage to={to} percentage={percentage} />
      </div>
    </div>
  );
}

function HelpAndAI({
  isCollapsed,
  isDragging,
  organizationId,
  projectId,
  onToggleCollapsed,
}: {
  isCollapsed: boolean;
  isDragging: boolean;
  organizationId: string;
  projectId: string;
  onToggleCollapsed: () => void;
}) {
  return (
    <LayoutGroup>
      <div
        className={cn(
          "flex w-full",
          isCollapsed ? "flex-col-reverse gap-1" : "items-center justify-between"
        )}
      >
        <ShortcutsAutoOpen />
        <HelpAndFeedback
          isCollapsed={isCollapsed}
          organizationId={organizationId}
          projectId={projectId}
        />
        <CollapseMenuButton
          isCollapsed={isCollapsed}
          isDragging={isDragging}
          onToggle={onToggleCollapsed}
        />
      </div>
    </LayoutGroup>
  );
}

function CollapseMenuButton({
  isCollapsed,
  isDragging = false,
  onToggle,
}: {
  isCollapsed: boolean;
  isDragging?: boolean;
  onToggle: () => void;
}) {
  const [isHovering, setIsHovering] = useState(false);

  return (
    // Shrink-and-fade only while dragging CLOSED, where this sits beside Help & Feedback and would
    // overlap it as the row narrows. Dragging OPEN it stays put: collapsed, this IS the expand
    // affordance, and the 0->1 variable would make the icon grow from nothing. At rest: natural size.
    <div
      className={cn(isDragging && !isCollapsed && "pointer-events-none overflow-hidden")}
      style={
        isDragging && !isCollapsed
          ? {
              maxWidth: "calc(var(--sm-label-opacity, 1) * 32px)",
              opacity: "var(--sm-label-opacity, 1)",
            }
          : undefined
      }
    >
      <TooltipProvider disableHoverableContent>
        <Tooltip delayDuration={isCollapsed ? 0 : 500}>
          <TooltipTrigger asChild>
            <span
              className={cn("inline-flex h-8", isCollapsed && "w-full")}
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
            >
              <Button
                variant="small-menu-item"
                aria-label={isCollapsed ? "Expand side menu" : "Collapse side menu"}
                onClick={onToggle}
                fullWidth={isCollapsed}
                className={cn("h-full", isCollapsed && "justify-center")}
              >
                {isCollapsed ? (
                  <LeftSideMenuCollapsedIcon
                    className={cn(
                      "size-5 transition-colors",
                      isHovering ? "text-text-bright" : "text-text-dimmed"
                    )}
                  />
                ) : (
                  <LeftSideMenuIcon
                    className={cn(
                      "size-5 transition-colors",
                      isHovering ? "text-text-bright" : "text-text-dimmed"
                    )}
                    hovered={isHovering}
                  />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="flex items-center gap-2 text-xs">
            {isCollapsed ? "Expand" : "Collapse"}
            <span className="flex items-center">
              <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
              <ShortcutKey shortcut={{ key: "b" }} variant="medium/bright" />
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

/**
 * Resize affordance straddling the menu's right border: hover reveals an indigo line, drag resizes,
 * click toggles collapsed/expanded, and the tooltip follows the pointer's Y. The strip extends 4px
 * past the edge, so the menu root deliberately has no overflow-hidden (only its inner grid does).
 */
function ResizeHandle({
  isCollapsed,
  isDragging,
  onPointerDown,
}: {
  isCollapsed: boolean;
  isDragging: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  // Fully controlled so open never flips controlled/uncontrolled mid-interaction; open requests
  // during a drag are dropped.
  const [isTooltipOpen, setTooltipOpen] = useState(false);
  // Pointer Y within the strip — anchors the tooltip beside the cursor, not the strip's center.
  const [anchorY, setAnchorY] = useState(0);

  return (
    <TooltipProvider disableHoverableContent>
      <Tooltip
        delayDuration={500}
        open={isTooltipOpen && !isDragging}
        onOpenChange={(open) => setTooltipOpen(open && !isDragging)}
      >
        <TooltipTrigger asChild>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize side menu"
            onPointerDown={onPointerDown}
            onPointerMove={(e) => {
              if (isDragging) return;
              setAnchorY(Math.round(e.clientY - e.currentTarget.getBoundingClientRect().top));
            }}
            className="group/resize absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize touch-none"
          >
            <div
              className={cn(
                "pointer-events-none absolute inset-y-0 left-1/2 w-0.75 -translate-x-1/2 bg-indigo-500 opacity-0 transition-opacity duration-300",
                isDragging ? "opacity-100" : "group-hover/resize:opacity-100"
              )}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          alignOffset={anchorY - 22}
          sideOffset={8}
          className="flex flex-col gap-1 text-xs"
        >
          <span>Drag to resize</span>
          <span className="flex items-center gap-1 text-text-dimmed">
            {isCollapsed ? "Click to expand" : "Click to collapse"}
            <span className="flex items-center">
              <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
              <ShortcutKey shortcut={{ key: "b" }} variant="medium/bright" />
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

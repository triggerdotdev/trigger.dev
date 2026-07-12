import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useFetcher, useNavigate, useNavigation, useSubmit } from "@remix-run/react";
import { LayoutGroup, motion } from "framer-motion";
import {
  type CSSProperties,
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
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { useHasAdminAccess } from "~/hooks/useUser";
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
  limitsPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationPath,
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
  v3ProjectPath,
  v3ProjectSettingsGeneralPath,
  v3ProjectSettingsIntegrationsPath,
  v3PromptsPath,
  v3QueuesPath,
  v3RunsPath,
  v3SessionsPath,
  v3UsagePath,
  v3WaitpointTokensPath,
} from "~/utils/pathBuilder";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { ConnectionIcon, DevPresencePanel, useDevPresence } from "../DevPresence";
import { AlphaBadge, NewBadge } from "../FeatureBadges";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import { Dialog, DialogTrigger } from "../primitives/Dialog";
import { Paragraph } from "../primitives/Paragraph";
import { Badge } from "../primitives/Badge";
import { Popover, PopoverContent, PopoverMenuItem, PopoverTrigger } from "../primitives/Popover";
import { ShortcutKey } from "../primitives/ShortcutKey";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";
import { ShortcutsAutoOpen } from "../Shortcuts";
import { CreateDashboardButton } from "./DashboardDialogs";
import { DashboardList } from "./DashboardList";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { HelpAndFeedback } from "./HelpAndFeedbackPopover";
import { NotificationPanel } from "./NotificationPanel";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import { type SideMenuSectionId } from "./sideMenuTypes";

/** Get the collapsed state for a specific side menu section from user preferences */
function getSectionCollapsed(
  sideMenu: { collapsedSections?: Record<string, boolean> } | undefined,
  sectionId: SideMenuSectionId
): boolean {
  return sideMenu?.collapsedSections?.[sectionId] ?? false;
}

// Size the side menu popover items (org menu + project picker) to match the side
// menu items: a 20px leading icon and a 0.90625rem label (vs the smaller
// small-menu-item defaults). The icon class overrides the variant icon size; the
// label class lands on the button element and overrides its text-2sm via
// tailwind-merge. The icon constant also carries the default dimmed color; items
// that need a different icon color (e.g. the indigo project folders) set their own.
const SIDE_MENU_POPOVER_ITEM_ICON = "h-5 w-5 text-text-dimmed";
const SIDE_MENU_POPOVER_ITEM_LABEL = "text-[0.90625rem] font-medium tracking-[-0.01em]";

// Accent used to signal impersonation mode across the UI (the side menu border and the
// "Stop impersonating" action). Full class strings per Tailwind's static scanning — change
// the shade here to update everywhere.
const IMPERSONATION_ACCENT = {
  border: "border-yellow-500/80",
  text: "text-yellow-500/80",
};

// --- Resizable side menu -----------------------------------------------------
// The menu can be dragged wider/narrower from a handle on its right edge. All of the
// width-driven visuals (label opacity, section headers, padding, "Project" → "Proj") are driven
// off two CSS variables set on the root during a drag/animation:
//   --sm-collapse:        0 (at/above the default width) → 1 (fully collapsed)
//   --sm-label-opacity:   1 (labels visible) → 0 (labels faded), a faster curve of --sm-collapse
// Keeping these on the root (rather than in React state) means a drag only writes two properties
// to one element per frame — no React re-render — so it stays smooth.

/** Collapsed rail width in px (matches the previous `w-11`). */
const COLLAPSED_WIDTH = 44;
/** The default/again-expanded width in px (matches the previous `w-56`). */
const DEFAULT_WIDTH = 224;
/** The widest the menu can be dragged, in px. */
const MAX_WIDTH = 400;
/** Duration of the collapse/expand/snap animation, in ms. */
const COLLAPSE_ANIM_MS = 200;
/**
 * Fraction of the collapse range (default → collapsed) over which the labels fade to 0. At 0.6 the
 * labels are fully transparent once the menu is 60% of the way to collapsed, i.e. before the rail
 * reaches its collapsed width. Tweak to taste.
 */
const LABEL_FADE_FRACTION = 0.6;
/**
 * Where a release in the sub-default zone snaps, measured as collapse progress (0 = default
 * width, 1 = collapsed): release at progress <= threshold and the menu springs open, past it and
 * it collapses. Each drag direction has its own threshold so letting go early usually continues
 * the gesture: dragging closed only collapses once past the first quarter of the range, while
 * dragging open re-opens once pulled just a tenth of the way out. Tweak to taste.
 */
const COLLAPSE_SNAP_THRESHOLD = 0.25;
const EXPAND_SNAP_THRESHOLD = 0.9;
/** Pointer travel (px) below which a press on the handle counts as a click (toggle), not a drag. */
const DRAG_CLICK_THRESHOLD = 4;

/** Left/right padding of the pinned top section + scroll body, interpolated 10px → 4px by --sm-collapse. */
const SIDE_MENU_PAD_X = `calc(0.625rem - 0.375rem * var(--sm-collapse, 0))`;
/**
 * Right padding of the scroll body, interpolated 0 → 4px by --sm-collapse: expanded, the reserved
 * scrollbar gutter provides the right-side space; collapsed there is no gutter, so this keeps the
 * rail buttons inset symmetrically (matching the left padding) instead of touching the edge.
 */
const SIDE_MENU_SCROLL_PAD_RIGHT = `calc(0.25rem * var(--sm-collapse, 0))`;
/**
 * The selector rows' hover chevron: its 16px of layout width follows --sm-label-opacity so an
 * invisible chevron can never hold width mid-drag and push the row's overflow clip edge into the
 * icon on the left (it would read as the icon being "masked"). Opacity stays class-driven — the
 * chevron is a hover-only affordance.
 */
const SIDE_MENU_CHEVRON_STYLE = {
  maxWidth: "calc(var(--sm-label-opacity, 1) * 16px)",
} as const;
/**
 * The selector rows' label container (org/project/environment): width and opacity both follow
 * --sm-label-opacity so the label tracks a drag frame-by-frame in BOTH directions. Gating these on
 * `isCollapsed` (which only flips on release) made the labels pop in after a drag-open instead of
 * fading in like the nav items. The variable also animates during the click-toggle, and is 0/1 at
 * the collapsed/expanded resting states, so no isCollapsed classes or CSS transitions are needed.
 */
const SIDE_MENU_SELECTOR_LABEL_STYLE = {
  maxWidth: "calc(var(--sm-label-opacity, 1) * 200px)",
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

/**
 * cubic-bezier(0.4, 0, 0.2, 1) — the standard easing, evaluated for the rAF width/progress tween so
 * it matches the feel of the CSS transitions used elsewhere in the side menu.
 */
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

  // --- Resize state (see the module constants above) ---
  const rootRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  // Mirror of `isCollapsed` for the drag handlers, which live outside React's render cycle and
  // must never act on a stale closure.
  const isCollapsedRef = useRef(isCollapsed);
  // The last-committed expanded width; animation targets and re-expansion read from here.
  const expandedWidthRef = useRef(
    clamp(user.dashboardPreferences.sideMenu?.width ?? DEFAULT_WIDTH, DEFAULT_WIDTH, MAX_WIDTH)
  );
  // Frozen initial width for the first paint. It never changes across renders, so React sets it
  // once and never fights the imperative width writes that drive the drag/animation.
  const initialWidthRef = useRef(
    (user.dashboardPreferences.sideMenu?.isCollapsed ?? false)
      ? COLLAPSED_WIDTH
      : expandedWidthRef.current
  );
  const widthRef = useRef(initialWidthRef.current);
  const progressRef = useRef((user.dashboardPreferences.sideMenu?.isCollapsed ?? false) ? 1 : 0);
  // Frozen initial style, including the CSS variables, so the server-rendered HTML already carries
  // the correct collapsed/expanded visuals (no expanded-state flash before hydration). The object
  // identity never changes, so React never rewrites these after writeVisual takes over the DOM.
  const initialStyleRef = useRef<CSSProperties>({
    width: initialWidthRef.current,
    "--sm-collapse": String(progressRef.current),
    "--sm-label-opacity": String(progressToLabelOpacity(progressRef.current)),
  } as CSSProperties);
  // Removes the window-level listeners of an in-flight drag (set on pointerdown, cleared when the
  // drag finishes or the component unmounts).
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
  const { isManagedCloud } = useFeatures();
  const featureFlags = useFeatureFlags();
  const incidentStatus = useIncidentStatus();
  const isV3Project = project.engine === "V1";

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

  // Flush pending preferences on unmount to avoid losing the last toggle
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (user.isImpersonating) return;
      const pending = pendingPreferencesRef.current;
      const hasPendingChanges =
        pending.isCollapsed !== undefined ||
        pending.width !== undefined ||
        (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined);

      if (hasPendingChanges) {
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
      }
    };
  }, [preferencesFetcher, user.isImpersonating]);

  // Write the width + collapse variables straight to the DOM (no React re-render) so a drag stays
  // smooth. Everything width-driven (labels, headers, padding, dividers) reads these variables.
  const writeVisual = useCallback((width: number, progress: number) => {
    widthRef.current = width;
    progressRef.current = progress;
    const el = rootRef.current;
    if (!el) return;
    el.style.width = `${width}px`;
    el.style.setProperty("--sm-collapse", String(progress));
    el.style.setProperty("--sm-label-opacity", String(progressToLabelOpacity(progress)));
  }, []);

  // Animate width + progress together over COLLAPSE_ANIM_MS with the standard easing (used for the
  // toggle button, the ⌘B shortcut, and the release-snap).
  const animateTo = useCallback(
    (targetWidth: number, targetProgress: number) => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const startWidth = widthRef.current;
      const startProgress = progressRef.current;
      if (startWidth === targetWidth && startProgress === targetProgress) return;
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
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [writeVisual]
  );

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

  // The whole drag lives in window-level listeners installed here, so releasing the pointer
  // anywhere — outside the handle, past the menu's min width, even outside the window — always
  // finalizes the drag. (Pointer capture alone proved unreliable: if the browser drops it
  // mid-drag, the release handler never fires and the menu is left stranded mid-resize.)
  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Capture keeps hover states elsewhere quiet while dragging; the drag itself does not
      // depend on it (and must not die if capture is unavailable for this pointer).
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
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
        // A drag that started collapsed is an opening gesture, so its snap zone is flipped:
        // releasing early continues opening rather than falling back to collapsed.
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
          // Released deeper in (including over-drags past the min width) — collapse the rest of
          // the way.
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

  // Keep the drag handlers' mirror of the collapsed state in sync, and tear down any in-flight
  // animation/drag listeners on unmount.
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

  return (
    <div
      ref={rootRef}
      style={initialStyleRef.current}
      className={cn(
        "relative h-full border-r bg-background-bright",
        user.isImpersonating ? IMPERSONATION_ACCENT.border : "border-grid-bright"
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
                {environment.type === "DEVELOPMENT" && project.engine === "V2" && (
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
            isCollapsed
              ? "scrollbar-none"
              : "scrollbar-gutter-stable scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
          )}
        >
          <div
            className="mb-6 flex w-full flex-col gap-4 overflow-hidden"
            style={{ paddingLeft: SIDE_MENU_PAD_X, paddingRight: SIDE_MENU_SCROLL_PAD_RIGHT }}
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
              />
              <SideMenuItem
                name="Runs"
                icon={RunsIcon}
                activeIconColor="text-runs"
                inactiveIconColor="text-text-dimmed"
                to={v3RunsPath(organization, project, environment)}
                data-action="runs"
                isCollapsed={isCollapsed}
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
              />
            </div>

            {(user.admin || user.isImpersonating || featureFlags.hasAiAccess) && (
              <SideMenuSection
                title="AI"
                isSideMenuCollapsed={isCollapsed}
                itemSpacingClassName="space-y-0"
                initialCollapsed={getSectionCollapsed(user.dashboardPreferences.sideMenu, "ai")}
                onCollapseToggle={handleSectionToggle("ai")}
              >
                <SideMenuItem
                  name="Prompts"
                  icon={AIPenIcon}
                  trailingIconClassName="size-6"
                  activeIconColor="text-aiPrompts"
                  inactiveIconColor="text-text-dimmed"
                  to={v3PromptsPath(organization, project, environment)}
                  data-action="prompts"
                  badge={<NewBadge />}
                  isCollapsed={isCollapsed}
                />
                {(user.admin || user.isImpersonating || featureFlags.hasAiAccess) && (
                  <SideMenuItem
                    name="Models"
                    icon={Box3DIcon}
                    activeIconColor="text-models"
                    inactiveIconColor="text-text-dimmed"
                    to={v3ModelsPath(organization, project, environment)}
                    data-action="models"
                    badge={<NewBadge />}
                    isCollapsed={isCollapsed}
                  />
                )}
              </SideMenuSection>
            )}

            {(user.admin || user.isImpersonating || featureFlags.hasQueryAccess) && (
              <SideMenuSection
                title="Observability"
                isSideMenuCollapsed={isCollapsed}
                itemSpacingClassName="space-y-0"
                initialCollapsed={getSectionCollapsed(
                  user.dashboardPreferences.sideMenu,
                  "metrics"
                )}
                onCollapseToggle={handleSectionToggle("metrics")}
              >
                {(user.admin || user.isImpersonating || featureFlags.hasLogsPageAccess) && (
                  <SideMenuItem
                    name="Logs"
                    icon={LogsIcon}
                    activeIconColor="text-logs"
                    inactiveIconColor="text-text-dimmed"
                    to={v3LogsPath(organization, project, environment)}
                    data-action="logs"
                    badge={<AlphaBadge />}
                    isCollapsed={isCollapsed}
                  />
                )}
                <SideMenuItem
                  name="Errors"
                  icon={BugIcon}
                  activeIconColor="text-errors"
                  inactiveIconColor="text-text-dimmed"
                  to={v3ErrorsPath(organization, project, environment)}
                  data-action="errors"
                  isCollapsed={isCollapsed}
                />
                <SideMenuItem
                  name="Query"
                  icon={CodeSquareIcon}
                  activeIconColor="text-query"
                  inactiveIconColor="text-text-dimmed"
                  to={queryPath(organization, project, environment)}
                  data-action="query"
                  isCollapsed={isCollapsed}
                />
                <SideMenuItem
                  name="Queues"
                  icon={QueuesIcon}
                  activeIconColor="text-queues"
                  inactiveIconColor="text-text-dimmed"
                  to={v3QueuesPath(organization, project, environment)}
                  data-action="queues"
                  isCollapsed={isCollapsed}
                />
                <SideMenuItem
                  name="Dashboards"
                  icon={ChartBarIcon}
                  activeIconColor="text-metrics"
                  inactiveIconColor="text-text-dimmed"
                  to={v3DashboardsLandingPath(organization, project, environment)}
                  data-action="dashboards-landing"
                  isCollapsed={isCollapsed}
                  action={
                    <CreateDashboardButton
                      organization={organization}
                      project={project}
                      environment={environment}
                      isCollapsed={isCollapsed}
                    />
                  }
                />
                <DashboardList
                  organization={organization}
                  project={project}
                  environment={environment}
                  isCollapsed={isCollapsed}
                  user={user}
                />
              </SideMenuSection>
            )}

            <SideMenuSection
              title="Deployments"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(
                user.dashboardPreferences.sideMenu,
                "deployments"
              )}
              onCollapseToggle={handleSectionToggle("deployments")}
            >
              <SideMenuItem
                name="Deploys"
                icon={DeploymentsIcon}
                activeIconColor="text-deployments"
                inactiveIconColor="text-text-dimmed"
                to={v3DeploymentsPath(organization, project, environment)}
                data-action="deployments"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Environment variables"
                icon={IDIcon}
                activeIconColor="text-environmentVariables"
                inactiveIconColor="text-text-dimmed"
                to={v3EnvironmentVariablesPath(organization, project, environment)}
                data-action="environment variables"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Preview branches"
                icon={BranchEnvironmentIconSmall}
                activeIconColor="text-previewBranches"
                inactiveIconColor="text-text-dimmed"
                to={branchesPath(organization, project, environment)}
                data-action="preview-branches"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Regions"
                icon={GlobeLinesIcon}
                activeIconColor="text-regions"
                inactiveIconColor="text-text-dimmed"
                to={regionsPath(organization, project, environment)}
                data-action="regions"
                isCollapsed={isCollapsed}
              />
            </SideMenuSection>

            <SideMenuSection
              title="Manage"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(user.dashboardPreferences.sideMenu, "manage")}
              onCollapseToggle={handleSectionToggle("manage")}
            >
              <SideMenuItem
                name="Waitpoint tokens"
                icon={WaitpointTokenIcon}
                activeIconColor="text-sky-500"
                inactiveIconColor="text-text-dimmed"
                to={v3WaitpointTokensPath(organization, project, environment)}
                data-action="waitpoint-tokens"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Batches"
                icon={BatchesIcon}
                activeIconColor="text-batches"
                inactiveIconColor="text-text-dimmed"
                to={v3BatchesPath(organization, project, environment)}
                data-action="batches"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Bulk actions"
                icon={ListCheckedIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3BulkActionsPath(organization, project, environment)}
                data-action="bulk actions"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="API keys"
                icon={KeyIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ApiKeysPath(organization, project, environment)}
                data-action="api keys"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Alerts"
                icon={BellIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectAlertsPath(organization, project, environment)}
                data-action="alerts"
                isCollapsed={isCollapsed}
              />
              {isManagedCloud && (
                <SideMenuItem
                  name="Concurrency"
                  icon={ConcurrencyIcon}
                  activeIconColor="text-text-bright"
                  inactiveIconColor="text-text-dimmed"
                  to={concurrencyPath(organization, project, environment)}
                  data-action="concurrency"
                  isCollapsed={isCollapsed}
                />
              )}
              <SideMenuItem
                name="Limits"
                icon={DialIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={limitsPath(organization, project, environment)}
                data-action="limits"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Integrations"
                icon={IntegrationsIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectSettingsIntegrationsPath(organization, project, environment)}
                data-action="project-settings-integrations"
                isCollapsed={isCollapsed}
              />
            </SideMenuSection>
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
              <CollapsibleHeight isCollapsed={isCollapsed}>
                <FreePlanUsage
                  to={v3BillingPath(organization)}
                  percentage={currentPlan.v3Usage.usagePercentage}
                />
              </CollapsibleHeight>
            )}
          </motion.div>
        </div>
      </div>
    </div>
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
            content="V3 deprecation warning"
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
          V3 deprecation warning
        </Paragraph>
      </div>
      <Paragraph variant="extra-small/bright" className="text-amber-300">
        This is a v3 project. V3 deploys will stop working on 1 April 2026. Full shutdown is 1 July
        2026 where all v3 runs will stop executing. Migrate to v4 to avoid downtime.
      </Paragraph>
      <LinkButton
        variant="secondary/small"
        to="https://trigger.dev/docs/migrating-from-v3"
        target="_blank"
        fullWidth
        TrailingIcon={ArrowTopRightOnSquareIcon}
        trailingIconClassName="text-amber-300"
        className="border-amber-500/30 bg-amber-500/15 hover:border-amber-500/50! hover:bg-amber-500/25!"
      >
        <span className="text-amber-300">View migration guide</span>
      </LinkButton>
    </div>
  );
}

function OrgSelector({
  organization,
  organizations,
  isCollapsed = false,
  isDragging = false,
}: {
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  isCollapsed?: boolean;
  /** True while the menu is being drag-resized; keeps the row in its expanded arrangement. */
  isDragging?: boolean;
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
    setOrgMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setOrgMenuOpen(open)} open={isOrgMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-1.75 hover:bg-background-hover focus-custom",
              // The expanded row arrangement applies while dragging too — the resting classes only
              // flip on release, and the label reveal mid-drag needs the expanded layout.
              isDragging || !isCollapsed ? "w-full justify-between pr-1" : "justify-center pr-0.5"
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <Avatar avatar={organization.avatar} size={1.25} orgName={organization.title} />
              <span
                className="flex min-w-0 items-center gap-1.5 overflow-hidden"
                style={SIDE_MENU_SELECTOR_LABEL_STYLE}
              >
                <span className="truncate text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                  {organization.title}
                </span>
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
      </PopoverContent>
    </Popover>
  );
}

function AccountMenu({ isAdmin, isImpersonating }: { isAdmin: boolean; isImpersonating: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const navigation = useNavigation();
  const navigate = useNavigate();
  const submit = useSubmit();

  useEffect(() => {
    setIsOpen(false);
  }, [navigation.location?.pathname]);

  const stopImpersonating = () =>
    submit(null, { action: "/resources/impersonation", method: "delete" });

  useShortcutKeys({
    shortcut: isAdmin
      ? { modifiers: ["mod"], key: "esc", enabledOnInputElements: true }
      : undefined,
    action: () => {
      if (isImpersonating) {
        stopImpersonating();
      } else {
        navigate(adminPath());
      }
    },
  });

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
        {isAdmin && (
          <div className="flex flex-col gap-1 border-b border-grid-bright p-1">
            {isImpersonating ? (
              <PopoverMenuItem
                title={
                  <div className="flex w-full items-center justify-between">
                    <span className={IMPERSONATION_ACCENT.text}>Stop impersonating</span>
                    <span className="flex items-center gap-1">
                      <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
                      <ShortcutKey shortcut={{ key: "esc" }} variant="medium/bright" />
                    </span>
                  </div>
                }
                icon={UserCrossIcon}
                onClick={stopImpersonating}
                leadingIconClassName={cn(SIDE_MENU_POPOVER_ITEM_ICON, IMPERSONATION_ACCENT.text)}
                className={SIDE_MENU_POPOVER_ITEM_LABEL}
              />
            ) : (
              <PopoverMenuItem
                to={adminPath()}
                title={
                  <div className="flex w-full items-center justify-between">
                    <span>Admin dashboard</span>
                    <span className="flex items-center gap-1">
                      <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
                      <ShortcutKey shortcut={{ key: "esc" }} variant="medium/bright" />
                    </span>
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

  useEffect(() => {
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded border pl-1.75 transition-[border-color] duration-150 hover:bg-background-hover focus-custom",
              // The expanded row arrangement applies while dragging too — the resting classes only
              // flip on release, and the label reveal mid-drag needs the expanded layout.
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
                <span className="truncate text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright">
                  {project.name ?? "Select a project"}
                </span>
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
                to={v3ProjectPath(organization, p)}
                title={
                  <div className="flex w-full items-center justify-between text-text-bright">
                    <span className="grow truncate text-left">{p.name}</span>
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

function SwitchOrganizations({
  organizations,
  organization,
}: {
  organizations: MatchedOrganization[];
  organization: MatchedOrganization;
}) {
  const navigation = useNavigation();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [navigation.location?.pathname]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setMenuOpen(true);
  };

  const handleMouseLeave = () => {
    // Small delay before closing to allow moving to the content
    timeoutRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, 150);
  };

  return (
    <Popover onOpenChange={(open) => setMenuOpen(open)} open={isMenuOpen}>
      <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="flex">
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className={cn("hover:bg-background-hover", SIDE_MENU_POPOVER_ITEM_LABEL)}
            LeadingIcon={ArrowLeftRightIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            Switch organization
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className="min-w-64 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
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
                to={organizationPath(org)}
                title={org.title}
                icon={<Avatar size={1.25} avatar={org.avatar} orgName={org.title} />}
                leadingIconClassName="text-text-dimmed"
                className={SIDE_MENU_POPOVER_ITEM_LABEL}
                isSelected={org.id === organization.id}
              />
            ))}
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}

function Integrations({ organization }: { organization: MatchedOrganization }) {
  const navigation = useNavigation();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [navigation.location?.pathname]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setMenuOpen(true);
  };

  const handleMouseLeave = () => {
    // Small delay before closing to allow moving to the content
    timeoutRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, 150);
  };

  return (
    <Popover onOpenChange={(open) => setMenuOpen(open)} open={isMenuOpen}>
      <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="flex">
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className={cn("hover:bg-background-hover", SIDE_MENU_POPOVER_ITEM_LABEL)}
            LeadingIcon={IntegrationsIcon}
            leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            Integrations
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className="min-w-64 overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
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
        </PopoverContent>
      </div>
    </Popover>
  );
}

/**
 * Helper component that fades out but preserves width (collapses to 0 width). The fade is driven
 * by the menu's `--sm-label-opacity` variable so it tracks a drag in real time (only max-width
 * transitions via CSS — transitioning the opacity too would lag the per-frame variable writes).
 */
function CollapsibleElement({
  isDragging = false,
  children,
  className,
}: {
  /** Only stops the fading button from swallowing clicks mid-drag; the hiding itself is width+opacity below. */
  isDragging?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // Width AND opacity follow the imperative `--sm-label-opacity` variable frame-by-frame. Opacity
  // alone is not enough: an invisible button that still holds its 32px of row width pushes the
  // primary item's overflow-hidden clip edge into its icon as the row narrows (the icon appears
  // "masked" mid-drag). Shrinking the width in the same curve hands that space back to the primary
  // item, keeping its icon fully visible at every width. The variable also animates during the
  // click-toggle (rAF-driven), so no CSS transition is needed — one would only lag the per-frame
  // writes. `isCollapsed` needs no explicit handling: the variable is 0 at rest-collapsed.
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

/** Helper component that fades out and collapses height completely */
function CollapsibleHeight({
  isCollapsed,
  children,
  className,
}: {
  isCollapsed: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid transition-all duration-200 ease-in-out",
        isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        className
      )}
    >
      <div className="overflow-hidden">{children}</div>
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
    // While dragging, width and opacity shrink with the `--sm-label-opacity` variable exactly like
    // CollapsibleElement, handing the freed row width to the Help & Feedback item so its icon is
    // never pushed into the row's clip edge. Unlike the other secondary buttons this only applies
    // mid-drag: at rest the button keeps its natural size in both states (when collapsed it is the
    // expand affordance), so the style is dropped on release, where the row relayout hides the snap.
    <div
      className={cn(isDragging && "pointer-events-none overflow-hidden")}
      style={
        isDragging
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
 * The resize affordance straddling the side menu's right border. Hovering fades in a 3px indigo
 * line (matching the app's ResizableHandle, with soft gradient ends), dragging resizes the menu,
 * and a plain click toggles it collapsed/expanded. The tooltip follows the pointer's vertical
 * position and explains both gestures.
 *
 * The strip extends 4px past the menu's edge; the menu root deliberately has no overflow-hidden
 * (only its inner grid does), so nothing clips the outer half.
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
  // Fully controlled so the open state never switches between controlled and uncontrolled
  // mid-interaction; open requests made while dragging are dropped.
  const [isTooltipOpen, setTooltipOpen] = useState(false);
  // The pointer's Y offset within the strip — anchors the tooltip beside the cursor instead of at
  // the strip's vertical center.
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

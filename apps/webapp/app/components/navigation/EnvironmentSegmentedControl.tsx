import { Link, useNavigation } from "@remix-run/react";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { useFeatures } from "~/hooks/useFeatures";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";
import { useDevPresence } from "../DevPresence";
import { environmentTextClassName } from "../environments/EnvironmentLabel";
import {
  Popover,
  PopoverContent,
  PopoverSectionHeader,
  PopoverTrigger,
} from "../primitives/Popover";
import { SimpleTooltip } from "../primitives/Tooltip";
import { BranchesPopoverContent, EnvironmentSelector } from "./EnvironmentSelector";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";

type EnvType = "DEVELOPMENT" | "STAGING" | "PREVIEW" | "PRODUCTION";

const SEGMENTS: { type: EnvType; label: string }[] = [
  { type: "DEVELOPMENT", label: "Dev" },
  { type: "STAGING", label: "Staging" },
  { type: "PREVIEW", label: "Prev" },
  { type: "PRODUCTION", label: "Prod" },
];

// Upgrade copy mirrors the dropdown's "Additional environments" prompts.
const UPGRADE_MESSAGE: Partial<Record<EnvType, string>> = {
  STAGING: "Upgrade to unlock a Staging environment for your projects.",
  PREVIEW: "Upgrade to unlock Preview environments for your projects.",
};

const PILL_LAYOUT_ID = "env-segmented-pill";

// The sliding selected pill is tinted with the env's own color.
const ENV_PILL: Record<EnvType, string> = {
  DEVELOPMENT: "border-dev/30 bg-dev/15",
  STAGING: "border-staging/30 bg-staging/15",
  PREVIEW: "border-preview/30 bg-preview/15",
  PRODUCTION: "border-prod/30 bg-prod/15",
};

const SEGMENT_CLASS =
  "group relative flex h-full grow items-center justify-center gap-1 rounded px-1.5 text-xs font-medium outline-none focus-custom";

/**
 * Side-menu-only environment switcher rendered as a segmented control (Dev /
 * Staging / Prev / Prod) instead of the dropdown `EnvironmentSelector`. The
 * dropdown is still used on blank-state panels and the Limits page.
 */
export function EnvironmentSegmentedControl({
  organization,
  project,
  environment,
  isCollapsed = false,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  isCollapsed?: boolean;
}) {
  const { urlForEnvironment } = useEnvironmentSwitcher();
  const { isManagedCloud } = useFeatures();
  const { isConnected } = useDevPresence();
  const navigation = useNavigation();
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  useEffect(() => {
    setIsPreviewOpen(false);
  }, [navigation.location?.pathname]);

  const rootEnvFor = (type: EnvType) =>
    project.environments.find((e) => e.type === type && e.parentEnvironmentId === null);

  // Which segment is active. A branch (e.g. a preview branch) resolves to its
  // parent env's type, so the parent segment shows as active.
  const activeType: EnvType = (() => {
    if (environment.parentEnvironmentId) {
      const parent = project.environments.find((e) => e.id === environment.parentEnvironmentId);
      if (parent) return parent.type as EnvType;
    }
    return environment.type as EnvType;
  })();

  // While the Preview popover is open, show Preview as the selected segment even
  // if we haven't navigated into a preview branch yet.
  const selectedType: EnvType = isPreviewOpen ? "PREVIEW" : activeType;

  // The dev connection is only tracked while you're in the dev environment (the
  // presence provider is enabled there), matching the old connection button.
  const showDevDot = environment.type === "DEVELOPMENT" && project.engine === "V2";

  // When collapsed there's no room for the segmented control, so fall back to the
  // original dropdown selector (env icon + menu).
  if (isCollapsed) {
    return (
      <EnvironmentSelector
        organization={organization}
        project={project}
        environment={environment}
        isCollapsed
        className="w-full"
      />
    );
  }

  return (
    <div className="flex h-8 w-full items-center gap-x-0.5 rounded bg-charcoal-750 p-0.5">
      {SEGMENTS.map((segment) => {
        const env = rootEnvFor(segment.type);
        const isSelected = selectedType === segment.type;
        const colorClass = isSelected
          ? environmentTextClassName({ type: segment.type })
          : "text-text-dimmed transition group-hover:text-text-bright";

        const pill = isSelected ? (
          <motion.div
            layoutId={PILL_LAYOUT_ID}
            transition={{ duration: 0.4, type: "spring" }}
            className={cn("absolute inset-0 rounded border", ENV_PILL[segment.type])}
          />
        ) : null;

        // Preview: opens the branch switcher popover on click (active or not).
        if (segment.type === "PREVIEW" && env) {
          const branchEnvironments = project.environments.filter(
            (e) => e.parentEnvironmentId === env.id
          );
          // When the active environment is a preview branch, show the branch name
          // truncated to 4 characters (plus an ellipsis) instead of "Prev".
          const branchName =
            environment.parentEnvironmentId === env.id ? environment.branchName : null;
          const previewLabel =
            branchName && branchName.length > 4
              ? `${branchName.slice(0, 4)}…`
              : (branchName ?? segment.label);
          return (
            <Popover key={segment.type} open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
              <PopoverTrigger className={SEGMENT_CLASS}>
                {pill}
                <span className={cn("relative z-10 truncate", colorClass)}>{previewLabel}</span>
                <DropdownIcon className={cn("relative z-10 size-3.5 shrink-0", colorClass)} />
              </PopoverTrigger>
              <PopoverContent
                className="min-w-[14rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
                align="start"
                side="bottom"
                sideOffset={6}
                style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
              >
                <PopoverSectionHeader title="Preview environments" />
                <BranchesPopoverContent
                  parentEnvironment={env}
                  branchEnvironments={branchEnvironments}
                  currentEnvironment={environment}
                />
              </PopoverContent>
            </Popover>
          );
        }

        // Missing env (Staging/Preview not provisioned): upgrade link on managed
        // cloud, otherwise a disabled segment.
        if (!env) {
          const upgradeMessage = UPGRADE_MESSAGE[segment.type];
          if (isManagedCloud && upgradeMessage) {
            return (
              <Link
                key={segment.type}
                to={v3BillingPath(organization, upgradeMessage)}
                className={SEGMENT_CLASS}
              >
                <span className="relative z-10 truncate text-text-dimmed transition group-hover:text-text-bright">
                  {segment.label}
                </span>
              </Link>
            );
          }
          return (
            <div key={segment.type} className={cn(SEGMENT_CLASS, "cursor-default")} aria-disabled>
              <span className="relative z-10 truncate text-charcoal-600">{segment.label}</span>
            </div>
          );
        }

        // Dev / Staging / Prod: navigate to the environment.
        return (
          <Link key={segment.type} to={urlForEnvironment(env)} className={SEGMENT_CLASS}>
            {pill}
            <span className={cn("relative z-10 truncate", colorClass)}>{segment.label}</span>
            {segment.type === "DEVELOPMENT" && showDevDot ? (
              <DevConnectionDot isConnected={isConnected} />
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Small status dot (top-right of the Dev segment) replacing the old connection
 * button: a pulsing green dot when connected, a static grey dot otherwise. Hover
 * (after a short delay) reveals the connection status as a tooltip.
 */
function DevConnectionDot({ isConnected }: { isConnected: boolean | undefined }) {
  const content =
    isConnected === undefined
      ? "Checking connection…"
      : isConnected
        ? "Your dev server is connected"
        : "Your dev server is not connected";

  return (
    <SimpleTooltip
      asChild
      disableHoverableContent
      delayDuration={500}
      side="right"
      sideOffset={8}
      content={content}
      button={
        <span className="absolute right-1 top-1 z-20 flex size-1.5">
          {isConnected ? (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex size-1.5 rounded-full",
              isConnected ? "bg-success" : "bg-charcoal-500"
            )}
          />
        </span>
      }
    />
  );
}

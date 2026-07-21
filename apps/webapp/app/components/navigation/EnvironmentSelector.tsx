import { ChevronRightIcon, Cog8ToothIcon } from "@heroicons/react/20/solid";
import { DEFAULT_DEV_BRANCH } from "@trigger.dev/core/v3/utils/gitBranch";
import { isBranchableEnvironment } from "~/utils/branchableEnvironment";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { useNavigation, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization, type MatchedOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { branchesPath, branchesDevPath, docsPath, v3BillingPath } from "~/utils/pathBuilder";
import {
  EnvironmentCombo,
  EnvironmentIcon,
  EnvironmentLabel,
  environmentFullTitle,
  environmentTextClassName,
} from "../environments/EnvironmentLabel";
import { ButtonContent } from "../primitives/Buttons";
import { Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverTrigger,
} from "../primitives/Popover";
import { TextLink } from "../primitives/TextLink";
import { SimpleTooltip } from "../primitives/Tooltip";
import { V4Badge } from "../V4Badge";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";
import { Badge } from "../primitives/Badge";

// Size this Env popover's items to match the Project popover (SIDE_MENU_POPOVER_ITEM_* in
// SideMenu.tsx). Only at these call sites, so shared EnvironmentLabel/EnvironmentCombo defaults stay.
const ENV_POPOVER_ITEM_ICON = "size-5";
const ENV_POPOVER_ITEM_LABEL = "text-[0.90625rem] font-medium tracking-[-0.01em]";

export function EnvironmentSelector({
  organization,
  project,
  environment,
  className,
  isCollapsed = false,
  isDragging = false,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  className?: string;
  isCollapsed?: boolean;
  /** True while the side menu is being drag-resized; keeps the row in its expanded arrangement. */
  isDragging?: boolean;
}) {
  const { isManagedCloud } = useFeatures();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { urlForEnvironment } = useEnvironmentSwitcher();
  const revalidator = useRevalidator();

  useEffect(() => {
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  // Fetch immediately on open so the list is fresh right away
  useEffect(() => {
    if (isMenuOpen && revalidator.state !== "loading") {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMenuOpen]);

  const hasStaging = project.environments.some((env) => env.type === "STAGING");
  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-1.75 hover:bg-background-hover focus-custom",
              // Expanded arrangement also applies mid-drag (resting classes flip only on release).
              isDragging || !isCollapsed ? "justify-between pr-1" : "justify-center pr-0.5",
              className
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <EnvironmentIcon environment={environment} className="size-5 shrink-0" />
              {/*
                In the side menu, opacity + max-width follow --sm-label-opacity (1 → 0): the label
                fades in place and scales its width to 0 so it never holds width mid-drag. The
                selector is also reused outside the side menu (BlankStatePanels, limits) where the var
                is unset — the 0.2 max-width fallback pins a ~200px cap (0.2 * 1000px) so long names
                ellipsis-truncate there instead of widening the control, while opacity stays 1.
              */}
              <span
                className="flex min-w-0 items-center overflow-hidden"
                style={{
                  maxWidth: "calc(var(--sm-label-opacity, 0.2) * 1000px)",
                  opacity: "var(--sm-label-opacity, 1)",
                }}
              >
                <EnvironmentLabel
                  environment={environment}
                  className="text-ellipsis text-[0.90625rem] font-medium tracking-[-0.01em]"
                  disableTooltip
                  truncate={false}
                />
              </span>
            </span>
            {/*
              Chevron's 16px width follows --sm-label-opacity so an invisible span never holds width
              mid-drag and pushes the row's clip edge into the icon.
            */}
            <span
              className="overflow-hidden opacity-0 group-hover:opacity-100"
              style={{ maxWidth: "calc(var(--sm-label-opacity, 1) * 16px)" }}
            >
              <DropdownIcon className="size-4 min-w-4 text-text-dimmed group-hover:text-text-bright" />
            </span>
          </PopoverTrigger>
        }
        content={`${environmentFullTitle(environment)} environment`}
        side="right"
        sideOffset={8}
        // Tooltip only on the collapsed rail (expanded shows the label; this selector is also reused
        // outside the side menu, where a hover tooltip is unwanted).
        hidden={!isCollapsed}
        delayDuration={0}
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
          {project.environments
            .filter((env) => env.parentEnvironmentId === null)
            .map((env) => {
              const renderAsBranchable = isBranchableEnvironment(env);

              if (renderAsBranchable) {
                const branchEnvironments = project.environments.filter(
                  (e) => e.parentEnvironmentId === env.id
                );
                const allBranchEnvironments =
                  env.type === "DEVELOPMENT" ? [env, ...branchEnvironments] : branchEnvironments;
                return (
                  <Branches
                    key={env.id}
                    parentEnvironment={env}
                    branchEnvironments={allBranchEnvironments}
                    currentEnvironment={environment}
                  />
                );
              }

              return (
                <PopoverMenuItem
                  key={env.id}
                  to={urlForEnvironment(env)}
                  title={
                    <EnvironmentCombo
                      environment={env}
                      className={cn("mx-auto grow", ENV_POPOVER_ITEM_LABEL)}
                      iconClassName={ENV_POPOVER_ITEM_ICON}
                    />
                  }
                  isSelected={env.id === environment.id}
                />
              );
            })}
        </div>
        {!hasStaging && isManagedCloud && (
          <>
            <PopoverSectionHeader title="Additional environments" />
            <div className="p-1">
              <PopoverMenuItem
                key="staging"
                to={v3BillingPath(
                  organization,
                  "Upgrade to unlock a Staging environment for your projects."
                )}
                title={
                  <div className="flex w-full items-center justify-between">
                    <EnvironmentCombo
                      environment={{ type: "STAGING" }}
                      className={ENV_POPOVER_ITEM_LABEL}
                      iconClassName={ENV_POPOVER_ITEM_ICON}
                    />
                    <span className={cn("text-indigo-500", ENV_POPOVER_ITEM_LABEL)}>Upgrade</span>
                  </div>
                }
                isSelected={false}
              />
              <PopoverMenuItem
                key="preview"
                to={v3BillingPath(
                  organization,
                  "Upgrade to unlock Preview environments for your projects."
                )}
                title={
                  <div className="flex w-full items-center justify-between">
                    <EnvironmentCombo
                      environment={{ type: "PREVIEW" }}
                      className={ENV_POPOVER_ITEM_LABEL}
                      iconClassName={ENV_POPOVER_ITEM_ICON}
                    />
                    <span className={cn("text-indigo-500", ENV_POPOVER_ITEM_LABEL)}>Upgrade</span>
                  </div>
                }
                isSelected={false}
              />
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Branches({
  parentEnvironment,
  branchEnvironments,
  currentEnvironment,
}: {
  parentEnvironment: SideMenuEnvironment;
  branchEnvironments: SideMenuEnvironment[];
  currentEnvironment: SideMenuEnvironment;
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
            className="hover:bg-background-hover"
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            <EnvironmentCombo
              environment={parentEnvironment}
              className={cn("mx-auto grow", ENV_POPOVER_ITEM_LABEL)}
              iconClassName={ENV_POPOVER_ITEM_ICON}
            />
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
          <BranchesPopoverContent
            parentEnvironment={parentEnvironment}
            branchEnvironments={branchEnvironments}
            currentEnvironment={currentEnvironment}
          />
        </PopoverContent>
      </div>
    </Popover>
  );
}

/**
 * Inner content of the branches popover (list, empty states, "Manage branches" footer). Shared by
 * the `Branches` hover submenu and the side-menu Preview popover.
 */
export function BranchesPopoverContent({
  parentEnvironment,
  branchEnvironments,
  currentEnvironment,
}: {
  parentEnvironment: SideMenuEnvironment;
  branchEnvironments: SideMenuEnvironment[];
  currentEnvironment: SideMenuEnvironment;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { urlForEnvironment } = useEnvironmentSwitcher();

  const activeBranches = branchEnvironments.filter((env) => env.archivedAt === null);
  const state =
    branchEnvironments.length === 0
      ? "no-branches"
      : activeBranches.length === 0
        ? "no-active-branches"
        : "has-branches";

  // Show the archived-branch item only in the submenu it belongs to: both Development and Preview
  // render this, so without the parent check an archived dev branch leaks into Preview (and vice-versa).
  const currentBranchIsArchived =
    environment.archivedAt !== null && environment.parentEnvironmentId === parentEnvironment.id;

  const envTextClassName = environmentTextClassName(parentEnvironment);

  return (
    <>
      <div className="flex flex-col gap-1 p-1">
        {parentEnvironment.type === "DEVELOPMENT" ? (
          <PopoverMenuItem
            to={branchesDevPath(organization, project, environment)}
            title="Manage dev branches"
            icon={<Cog8ToothIcon className={cn(ENV_POPOVER_ITEM_ICON, "text-text-dimmed")} />}
            leadingIconClassName="text-text-dimmed"
            className={ENV_POPOVER_ITEM_LABEL}
          />
        ) : (
          <PopoverMenuItem
            to={branchesPath(organization, project, environment)}
            title="Manage preview branches"
            icon={<Cog8ToothIcon className={cn(ENV_POPOVER_ITEM_ICON, "text-text-dimmed")} />}
            leadingIconClassName="text-text-dimmed"
            className={ENV_POPOVER_ITEM_LABEL}
          />
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-grid-bright p-1">
        {currentBranchIsArchived && (
          <PopoverMenuItem
            key={environment.id}
            to={urlForEnvironment(environment)}
            title={
              <>
                <span className={cn("block w-full", envTextClassName, ENV_POPOVER_ITEM_LABEL)}>
                  {environment.branchName}
                </span>
                <Badge variant="extra-small">Archived</Badge>
              </>
            }
            icon={
              <BranchEnvironmentIconSmall
                className={cn(ENV_POPOVER_ITEM_ICON, "shrink-0", envTextClassName)}
              />
            }
            isSelected={environment.id === currentEnvironment.id}
          />
        )}
        {state === "has-branches" ? (
          <>
            {branchEnvironments
              .filter((env) => env.archivedAt === null)
              .map((env) => (
                <PopoverMenuItem
                  key={env.id}
                  to={urlForEnvironment(env)}
                  title={
                    <span className={cn("block w-full", envTextClassName, ENV_POPOVER_ITEM_LABEL)}>
                      {env.branchName ?? DEFAULT_DEV_BRANCH}
                    </span>
                  }
                  icon={
                    <BranchEnvironmentIconSmall
                      className={cn(ENV_POPOVER_ITEM_ICON, "shrink-0", envTextClassName)}
                    />
                  }
                  isSelected={env.id === currentEnvironment.id}
                />
              ))}
          </>
        ) : state === "no-branches" ? (
          <div className="flex max-w-sm flex-col gap-1 p-2">
            <div className="flex items-center gap-1">
              <BranchEnvironmentIconSmall className={cn("size-4", envTextClassName)} />
              <Header2>Create your first branch</Header2>
            </div>
            <Paragraph spacing variant="small">
              Branches are a way to test new features in isolation before merging them into the main
              environment.
            </Paragraph>
            <Paragraph variant="small">
              Branches are only available when using <V4Badge inline /> or above. Read our{" "}
              <TextLink to={docsPath("upgrade-to-v4")}>v4 upgrade guide</TextLink> to learn more.
            </Paragraph>
          </div>
        ) : (
          <div className="flex max-w-sm flex-col gap-1 p-2">
            <Paragraph variant="extra-small">All branches are archived.</Paragraph>
          </div>
        )}
      </div>
    </>
  );
}

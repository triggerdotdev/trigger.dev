import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { ArrowUpCircleIcon } from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import {
  EnvironmentIcon,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { LinkButton } from "~/components/primitives/Buttons";
import { Hint } from "~/components/primitives/Hint";
import {
  SettingsActions,
  SettingsBlock,
  SettingsRow,
  SettingsRowDescription,
} from "~/components/primitives/SettingsLayout";
import { cn } from "~/utils/cn";

/** The same environment availability gates serve onboarding, settings and the state gallery. */
export function GitHubBranchTracking({
  productionInput,
  stagingInput,
  previewInput,
  stagingEnvironmentEnabled,
  previewEnvironmentEnabled,
  previewDeploymentsEnabled,
  billingPath,
  errors,
  saveAction,
  canManageGithub = true,
}: {
  productionInput: ReactNode;
  stagingInput: ReactNode;
  previewInput: ReactNode;
  stagingEnvironmentEnabled?: boolean;
  previewEnvironmentEnabled?: boolean;
  previewDeploymentsEnabled: boolean;
  billingPath: string;
  errors?: ReactNode;
  saveAction?: ReactNode;
  canManageGithub?: boolean;
}) {
  const upgrade = (
    <LinkButton
      to={billingPath}
      variant="secondary/small"
      LeadingIcon={ArrowUpCircleIcon}
      leadingIconClassName="text-indigo-500"
    >
      Upgrade
    </LinkButton>
  );
  const rowClass = "flex-wrap gap-3 [&>div:last-child]:max-w-full";
  return (
    <div data-testid="github-branch-tracking">
      <SettingsBlock size="sm">
        <Hint className="text-balance">
          Every push to the selected tracking branch creates a deployment in the corresponding
          environment.
        </Hint>
      </SettingsBlock>
      <SettingsRow
        className={rowClass}
        action={
          <GitHubPermissionTooltip denied={!canManageGithub}>
            {productionInput}
          </GitHubPermissionTooltip>
        }
      >
        <EnvironmentRowLabel type="PRODUCTION" />
      </SettingsRow>
      <SettingsRow
        className={rowClass}
        action={
          stagingEnvironmentEnabled ? (
            <GitHubPermissionTooltip denied={!canManageGithub}>
              {stagingInput}
            </GitHubPermissionTooltip>
          ) : (
            upgrade
          )
        }
      >
        <EnvironmentRowLabel
          type="STAGING"
          description={
            stagingEnvironmentEnabled
              ? undefined
              : "Upgrade your plan to enable a Staging environment"
          }
        />
      </SettingsRow>
      <SettingsRow
        className={rowClass}
        action={
          previewEnvironmentEnabled ? (
            <GitHubPermissionTooltip denied={!canManageGithub}>
              {previewInput}
            </GitHubPermissionTooltip>
          ) : (
            <>
              {previewDeploymentsEnabled && (
                <input type="hidden" name="previewDeploymentsEnabled" value="on" />
              )}
              {upgrade}
            </>
          )
        }
      >
        <EnvironmentRowLabel
          type="PREVIEW"
          description={
            previewEnvironmentEnabled ? undefined : "Upgrade your plan to enable preview branches"
          }
        />
      </SettingsRow>
      {errors}
      {saveAction && <SettingsActions>{saveAction}</SettingsActions>}
    </div>
  );
}

function EnvironmentRowLabel({
  type,
  description,
}: {
  type: "PRODUCTION" | "STAGING" | "PREVIEW";
  description?: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-1.5">
        <EnvironmentIcon environment={{ type }} className="size-4" />
        <span className={cn("text-sm", environmentTextClassName({ type }))}>
          {environmentFullTitle({ type })}
        </span>
      </div>
      {description && <SettingsRowDescription>{description}</SettingsRowDescription>}
    </div>
  );
}

/** Disabled native controls don't receive pointer events; the wrapper owns the tooltip. */
export function GitHubPermissionTooltip({
  denied,
  children,
}: {
  denied: boolean;
  children: ReactNode;
}) {
  if (!denied) return children;
  return (
    <SimpleTooltip
      asChild
      disableHoverableContent
      content="You don't have permission to manage GitHub settings."
      button={
        <span className="inline-flex max-w-full cursor-not-allowed [&>*]:pointer-events-none">
          {children}
        </span>
      }
    />
  );
}

import { Switch } from "~/components/primitives/Switch";
import { LinkButton } from "~/components/primitives/Buttons";
import { Badge } from "~/components/primitives/Badge";
import { Label } from "~/components/primitives/Label";
import {
  SettingsRow,
  SettingsRowDescription,
  SettingsRowTitle,
} from "~/components/primitives/SettingsLayout";
import { cn } from "~/utils/cn";
import { docsPath } from "~/utils/pathBuilder";
import { Hint } from "~/components/primitives/Hint";
import { TextLink } from "~/components/primitives/TextLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  EnvironmentIcon,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { envSlugToType, type EnvSlug } from "~/v3/vercel/vercelProjectIntegrationSchema";

export const SKEW_PROTECTION_DOCS_PATH = docsPath("deployment/version-skew-protection");

const SKEW_PROTECTION_MIN_SDK_VERSION: string | null = "4.5.12";

export function skewProtectionVersionRequirement(): string {
  return SKEW_PROTECTION_MIN_SDK_VERSION
    ? `from SDK and CLI v${SKEW_PROTECTION_MIN_SDK_VERSION} and later`
    : "from a recent SDK and CLI — see the docs for the exact version";
}

type BuildSettingsFieldsProps = {
  availableEnvSlugs: EnvSlug[];
  pullEnvVarsBeforeBuild: EnvSlug[];
  onPullEnvVarsChange: (slugs: EnvSlug[]) => void;
  discoverEnvVars: EnvSlug[];
  onDiscoverEnvVarsChange: (slugs: EnvSlug[]) => void;
  atomicBuilds: EnvSlug[];
  onAtomicBuildsChange: (slugs: EnvSlug[]) => void;
  envVarsConfigLink?: string;
  /** Slugs that should be forced off and disabled, with tooltip reason. */
  disabledEnvSlugs?: Partial<Record<EnvSlug, string>>;
  autoPromote?: boolean;
  onAutoPromoteChange?: (value: boolean) => void;
  /** The currently pinned TRIGGER_VERSION on Vercel production, if any. Shown under the
   * Atomic deployments toggle so the user knows what version is set on Vercel right now. */
  currentTriggerVersion?: string | null;
  /** True when the Vercel lookup for TRIGGER_VERSION failed. We show this so the user knows
   * the pin status is unknown — distinct from "not set". */
  currentTriggerVersionFetchFailed?: boolean;
  /** Hide the section-level master toggles for "Pull env vars" and "Discover new env vars". */
  hideSectionToggles?: boolean;
  showAtomicDeployments?: boolean;
  layout?: "settings" | "card";
};

export function BuildSettingsFields({
  availableEnvSlugs,
  pullEnvVarsBeforeBuild,
  onPullEnvVarsChange,
  discoverEnvVars,
  onDiscoverEnvVarsChange,
  atomicBuilds,
  onAtomicBuildsChange,
  envVarsConfigLink,
  disabledEnvSlugs,
  autoPromote,
  onAutoPromoteChange,
  currentTriggerVersion,
  currentTriggerVersionFetchFailed,
  hideSectionToggles,
  showAtomicDeployments = true,
  layout = "card",
}: BuildSettingsFieldsProps) {
  const isSlugDisabled = (slug: EnvSlug) => !!disabledEnvSlugs?.[slug];
  const enabledSlugs = availableEnvSlugs.filter((s) => !isSlugDisabled(s));

  const envVarSections =
    layout === "settings" ? (
      <>
        <SettingsRow
          align="end"
          title="Pull env vars before build"
          description="Pulled from Vercel on every build."
          action={
            envVarsConfigLink ? (
              <LinkButton to={envVarsConfigLink} variant="secondary/small">
                Configure env vars
              </LinkButton>
            ) : undefined
          }
        />
        {availableEnvSlugs.map((slug) => (
          <EnvToggleRow
            key={`pull-${slug}`}
            slug={slug}
            checked={isSlugDisabled(slug) ? false : pullEnvVarsBeforeBuild.includes(slug)}
            disabled={isSlugDisabled(slug)}
            disabledReason={disabledEnvSlugs?.[slug]}
            unlockHint={isSlugDisabled(slug) ? "staging-env" : undefined}
            unlockTarget={`pull-${slug}`}
            onCheckedChange={(checked) => {
              onPullEnvVarsChange(
                checked
                  ? [...pullEnvVarsBeforeBuild, slug]
                  : pullEnvVarsBeforeBuild.filter((s) => s !== slug)
              );
            }}
          />
        ))}

        <SettingsRow
          title="Discover new env vars"
          description="New variables on Vercel are created automatically during builds."
        />
        {availableEnvSlugs.map((slug) => {
          const pullOff = !pullEnvVarsBeforeBuild.includes(slug);
          return (
            <EnvToggleRow
              key={`discover-${slug}`}
              slug={slug}
              checked={isSlugDisabled(slug) ? false : discoverEnvVars.includes(slug)}
              disabled={isSlugDisabled(slug) || pullOff}
              disabledReason={
                disabledEnvSlugs?.[slug] ??
                (pullOff ? "Pull env vars for this environment first." : undefined)
              }
              unlockHint={
                isSlugDisabled(slug) ? "staging-env" : pullOff ? `pull-${slug}` : undefined
              }
              onCheckedChange={(checked) => {
                onDiscoverEnvVarsChange(
                  checked ? [...discoverEnvVars, slug] : discoverEnvVars.filter((s) => s !== slug)
                );
              }}
            />
          );
        })}
      </>
    ) : null;

  const atomicSections =
    layout === "settings" && showAtomicDeployments ? (
      <>
        <SettingsRow
          action={
            <Switch
              variant="medium"
              checked={atomicBuilds.includes("prod")}
              onCheckedChange={(checked) => {
                onAtomicBuildsChange(checked ? ["prod"] : []);
              }}
            />
          }
        >
          <div className="flex-1 space-y-1">
            <SettingsRowTitle>
              <span className="flex items-center gap-2">
                Atomic deployments <DeprecatedBadge />
              </span>
            </SettingsRowTitle>
            <SettingsRowDescription>
              Version skew protection replaces this. It pins every run to the deployment that
              triggered it, and works on its own {skewProtectionVersionRequirement()}. Atomic
              deployments still work, so turn this off whenever you're ready.{" "}
              <TextLink href={SKEW_PROTECTION_DOCS_PATH} target="_blank">
                Read about version skew protection
              </TextLink>
              .
            </SettingsRowDescription>
            <SettingsRowDescription>
              Atomic deployments promote your Vercel deployment and your tasks together in
              Production, so your app never runs against a mismatched task version. This needs
              "Auto-assign Custom Production Domains" turned off on your Vercel project, and
              Trigger.dev takes care of that for you.{" "}
              <TextLink
                href="https://trigger.dev/docs/vercel-integration#atomic-deployments"
                target="_blank"
              >
                Learn more
              </TextLink>
              .
            </SettingsRowDescription>
            {currentTriggerVersion && (
              <Hint>
                Currently pinned to{" "}
                <span className="font-mono text-text-bright">{currentTriggerVersion}</span> in
                Vercel production.
              </Hint>
            )}
            {!currentTriggerVersion && currentTriggerVersionFetchFailed && (
              <Hint className="text-warning">
                Couldn't read <span className="font-mono text-text-bright">TRIGGER_VERSION</span>{" "}
                from Vercel. Check the Vercel dashboard to confirm the production pin.
              </Hint>
            )}
          </div>
        </SettingsRow>

        {atomicBuilds.includes("prod") && onAutoPromoteChange !== undefined && (
          <SettingsRow
            title="Auto promotion"
            description="Part of atomic deployments, and only used while they are on. Once your tasks finish deploying, Trigger.dev promotes the Vercel deployment for you. Turn this off to promote from the Vercel dashboard yourself, and Trigger.dev will follow as soon as you do."
            action={
              <Switch
                variant="medium"
                checked={autoPromote ?? true}
                onCheckedChange={onAutoPromoteChange}
              />
            }
          />
        )}
      </>
    ) : null;

  return (
    <>
      {envVarSections}
      {/* Pull env vars before build */}
      {layout === "card" && (
        <div>
          <div className="mb-2">
            <div className="flex items-center justify-between">
              <Label>Pull env vars before build</Label>
              {!hideSectionToggles && availableEnvSlugs.length > 1 && (
                <Switch
                  variant="small"
                  checked={
                    enabledSlugs.length > 0 &&
                    enabledSlugs.every((s) => pullEnvVarsBeforeBuild.includes(s))
                  }
                  onCheckedChange={(checked) => {
                    onPullEnvVarsChange(checked ? [...enabledSlugs] : []);
                  }}
                />
              )}
            </div>
            <Hint className="pr-6">
              Select which environments should pull environment variables from Vercel before each
              build.{" "}
              {envVarsConfigLink && (
                <>
                  <TextLink to={envVarsConfigLink}>Configure which variables to pull</TextLink>.
                </>
              )}
            </Hint>
          </div>
          <div className="flex flex-col gap-2 rounded border bg-background-bright p-3">
            {availableEnvSlugs.map((slug) => {
              const envType = envSlugToType(slug);
              const disabled = isSlugDisabled(slug);
              const disabledReason = disabledEnvSlugs?.[slug];
              const row = (
                <div
                  key={slug}
                  className={`flex items-center justify-between ${disabled ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    <EnvironmentIcon environment={{ type: envType }} className="size-4" />
                    <span className={`text-sm ${environmentTextClassName({ type: envType })}`}>
                      {environmentFullTitle({ type: envType })}
                    </span>
                  </div>
                  <Switch
                    variant="small"
                    checked={disabled ? false : pullEnvVarsBeforeBuild.includes(slug)}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      onPullEnvVarsChange(
                        checked
                          ? [...pullEnvVarsBeforeBuild, slug]
                          : pullEnvVarsBeforeBuild.filter((s) => s !== slug)
                      );
                    }}
                  />
                </div>
              );
              if (disabled && disabledReason) {
                return (
                  <SimpleTooltip key={slug} button={row} content={disabledReason} side="left" />
                );
              }
              return row;
            })}
          </div>
        </div>
      )}

      {/* Discover new env vars */}
      {layout === "card" && (
        <div>
          <div className="mb-2">
            <div className="flex items-center justify-between">
              <Label>Discover new env vars</Label>
              {!hideSectionToggles && availableEnvSlugs.length > 1 && (
                <Switch
                  variant="small"
                  checked={
                    enabledSlugs.length > 0 &&
                    enabledSlugs.every(
                      (s) => discoverEnvVars.includes(s) || !pullEnvVarsBeforeBuild.includes(s)
                    ) &&
                    enabledSlugs.some((s) => discoverEnvVars.includes(s))
                  }
                  disabled={!enabledSlugs.some((s) => pullEnvVarsBeforeBuild.includes(s))}
                  onCheckedChange={(checked) => {
                    onDiscoverEnvVarsChange(
                      checked ? enabledSlugs.filter((s) => pullEnvVarsBeforeBuild.includes(s)) : []
                    );
                  }}
                />
              )}
            </div>
            <Hint className="pr-6">
              Select which environments should automatically discover and create new environment
              variables from Vercel during builds.
            </Hint>
          </div>
          <div className="flex flex-col gap-2 rounded border bg-background-bright p-3">
            {availableEnvSlugs.map((slug) => {
              const envType = envSlugToType(slug);
              const disabled = isSlugDisabled(slug);
              const disabledReason = disabledEnvSlugs?.[slug];
              const isPullDisabled = !pullEnvVarsBeforeBuild.includes(slug);
              const row = (
                <div
                  key={slug}
                  className={`flex items-center justify-between ${disabled || isPullDisabled ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    <EnvironmentIcon environment={{ type: envType }} className="size-4" />
                    <span className={`text-sm ${environmentTextClassName({ type: envType })}`}>
                      {environmentFullTitle({ type: envType })}
                    </span>
                  </div>
                  <Switch
                    variant="small"
                    checked={disabled ? false : discoverEnvVars.includes(slug)}
                    disabled={disabled || isPullDisabled}
                    onCheckedChange={(checked) => {
                      onDiscoverEnvVarsChange(
                        checked
                          ? [...discoverEnvVars, slug]
                          : discoverEnvVars.filter((s) => s !== slug)
                      );
                    }}
                  />
                </div>
              );
              if (disabled && disabledReason) {
                return (
                  <SimpleTooltip key={slug} button={row} content={disabledReason} side="left" />
                );
              }
              return row;
            })}
          </div>
        </div>
      )}

      {atomicSections}

      {/* Atomic deployments */}
      {layout === "card" && showAtomicDeployments && (
        <div>
          <div className="flex items-center justify-between">
            <Label>
              <span className="flex items-center gap-2">
                Atomic deployments <DeprecatedBadge />
              </span>
            </Label>
            <Switch
              variant="small"
              checked={atomicBuilds.includes("prod")}
              onCheckedChange={(checked) => {
                onAtomicBuildsChange(checked ? ["prod"] : []);
              }}
            />
          </div>
          <Hint className="pr-6">
            Version skew protection replaces this, and works on its own{" "}
            {skewProtectionVersionRequirement()}.{" "}
            <TextLink href={SKEW_PROTECTION_DOCS_PATH} target="_blank">
              Read about version skew protection
            </TextLink>
            .
          </Hint>
          <Hint className="pr-6">
            Atomic deployments promote your Vercel deployment and your tasks together in Production,
            so your app never runs against a mismatched task version. This needs "Auto-assign Custom
            Production Domains" turned off on your Vercel project, and Trigger.dev takes care of
            that for you.{" "}
            <TextLink
              href="https://trigger.dev/docs/vercel-integration#atomic-deployments"
              target="_blank"
            >
              Learn more
            </TextLink>
            .
          </Hint>
          {currentTriggerVersion && (
            <Hint className="pr-6">
              Currently pinned to{" "}
              <span className="font-mono text-text-bright">{currentTriggerVersion}</span> in Vercel
              production.
            </Hint>
          )}
          {!currentTriggerVersion && currentTriggerVersionFetchFailed && (
            <Hint className="pr-6 text-warning">
              Couldn't read <span className="font-mono text-text-bright">TRIGGER_VERSION</span> from
              Vercel — check the Vercel dashboard to confirm the production pin.
            </Hint>
          )}
        </div>
      )}

      {/* Auto promotion — only visible when atomic deployments are on */}
      {layout === "card" &&
        showAtomicDeployments &&
        atomicBuilds.includes("prod") &&
        onAutoPromoteChange !== undefined && (
          <div>
            <div className="flex items-center justify-between">
              <Label>Auto promotion</Label>
              <Switch
                variant="small"
                checked={autoPromote ?? true}
                onCheckedChange={onAutoPromoteChange}
              />
            </div>
            <Hint className="pr-6">
              When enabled, the integration automatically promotes the Vercel deployment after the
              Trigger.dev build completes. Turn off to manually promote from your Vercel dashboard —
              Trigger.dev will then promote automatically once you do.
            </Hint>
          </div>
        )}
    </>
  );
}

function DeprecatedBadge() {
  return (
    <SimpleTooltip
      asChild
      button={
        <Badge
          variant="extra-small"
          className="text-warning system:border-transparent system:bg-warning system:text-white"
        >
          Deprecated
        </Badge>
      }
      content="Use version skew protection instead"
      disableHoverableContent
    />
  );
}

function EnvToggleRow({
  slug,
  checked,
  disabled,
  disabledReason,
  unlockHint,
  unlockTarget,
  onCheckedChange,
}: {
  slug: EnvSlug;
  checked: boolean;
  disabled: boolean;
  disabledReason?: string;
  unlockHint?: string;
  unlockTarget?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const envType = envSlugToType(slug);

  return (
    <SettingsRow
      className={disabled && unlockHint ? `unlock-hint-${unlockHint}` : undefined}
      action={
        <span data-unlock-target={unlockTarget}>
          <Switch
            variant="medium"
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
          />
        </span>
      }
    >
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-1.5">
          <EnvironmentIcon
            environment={{ type: envType }}
            className={cn("size-4", disabled && "text-text-dimmed/50")}
          />
          <span
            className={cn(
              "text-sm",
              disabled ? "text-text-dimmed/50" : environmentTextClassName({ type: envType })
            )}
          >
            {environmentFullTitle({ type: envType })}
          </span>
        </div>
        {disabled && disabledReason ? (
          <SettingsRowDescription>{disabledReason}</SettingsRowDescription>
        ) : null}
      </div>
    </SettingsRow>
  );
}

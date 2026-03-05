import { Switch } from "~/components/primitives/Switch";
import { Label } from "~/components/primitives/Label";
import { Hint } from "~/components/primitives/Hint";
import { TextLink } from "~/components/primitives/TextLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  EnvironmentIcon,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { envSlugToType, type EnvSlug } from "~/v3/vercel/vercelProjectIntegrationSchema";

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
}: BuildSettingsFieldsProps) {
  const isSlugDisabled = (slug: EnvSlug) => !!disabledEnvSlugs?.[slug];
  const enabledSlugs = availableEnvSlugs.filter((s) => !isSlugDisabled(s));

  return (
    <>
      {/* Pull env vars before build */}
      <div>
        <div className="mb-2">
          <div className="flex items-center justify-between">
            <Label>Pull env vars before build</Label>
            {availableEnvSlugs.length > 1 && (
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
        <div className="flex flex-col gap-2 rounded border bg-charcoal-800 p-3">
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

      {/* Discover new env vars */}
      <div>
        <div className="mb-2">
          <div className="flex items-center justify-between">
            <Label>Discover new env vars</Label>
            {availableEnvSlugs.length > 1 && (
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
                    checked
                      ? enabledSlugs.filter((s) => pullEnvVarsBeforeBuild.includes(s))
                      : []
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
        <div className="flex flex-col gap-2 rounded border bg-charcoal-800 p-3">
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

      {/* Atomic deployments */}
      <div>
        <div className="flex items-center justify-between">
          <Label>Atomic deployments</Label>
          <Switch
            variant="small"
            checked={atomicBuilds.includes("prod")}
            onCheckedChange={(checked) => {
              onAtomicBuildsChange(checked ? ["prod"] : []);
            }}
          />
        </div>
        <Hint className="pr-6">
          When enabled, production deployments wait for Vercel deployment to complete before
          promoting the Trigger.dev deployment. This will disable the "Auto-assign Custom
          Production Domains" option in your Vercel project settings to perform staged
          deployments.{" "}
          <TextLink href="https://trigger.dev/docs/vercel-integration#atomic-deployments" target="_blank">
            Learn more
          </TextLink>
          .
        </Hint>
      </div>
    </>
  );
}

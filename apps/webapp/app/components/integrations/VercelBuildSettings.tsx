import { Switch } from "~/components/primitives/Switch";
import { Label } from "~/components/primitives/Label";
import { Hint } from "~/components/primitives/Hint";
import { TextLink } from "~/components/primitives/TextLink";
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
}: BuildSettingsFieldsProps) {
  return (
    <>
      {/* Pull env vars before build */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <Label>Pull env vars before build</Label>
            <Hint>
              Select which environments should pull environment variables from Vercel before each
              build.{" "}
              {envVarsConfigLink && (
                <>
                  <TextLink to={envVarsConfigLink}>Configure which variables to pull</TextLink>.
                </>
              )}
            </Hint>
          </div>
          {availableEnvSlugs.length > 1 && (
            <Switch
              variant="small"
              checked={
                availableEnvSlugs.length > 0 &&
                availableEnvSlugs.every((s) => pullEnvVarsBeforeBuild.includes(s))
              }
              onCheckedChange={(checked) => {
                onPullEnvVarsChange(checked ? [...availableEnvSlugs] : []);
              }}
            />
          )}
        </div>
        <div className="flex flex-col gap-2 rounded border bg-charcoal-800 p-3">
          {availableEnvSlugs.map((slug) => {
            const envType = envSlugToType(slug);
            return (
              <div key={slug} className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <EnvironmentIcon environment={{ type: envType }} className="size-4" />
                  <span className={`text-sm ${environmentTextClassName({ type: envType })}`}>
                    {environmentFullTitle({ type: envType })}
                  </span>
                </div>
                <Switch
                  variant="small"
                  checked={pullEnvVarsBeforeBuild.includes(slug)}
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
          })}
        </div>
      </div>

      {/* Discover new env vars */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <Label>Discover new env vars</Label>
            <Hint>
              Select which environments should automatically discover and create new environment
              variables from Vercel during builds.
            </Hint>
          </div>
          {availableEnvSlugs.length > 1 && (
            <Switch
              variant="small"
              checked={
                availableEnvSlugs.length > 0 &&
                availableEnvSlugs.every(
                  (s) => discoverEnvVars.includes(s) || !pullEnvVarsBeforeBuild.includes(s)
                ) &&
                availableEnvSlugs.some((s) => discoverEnvVars.includes(s))
              }
              disabled={!availableEnvSlugs.some((s) => pullEnvVarsBeforeBuild.includes(s))}
              onCheckedChange={(checked) => {
                onDiscoverEnvVarsChange(
                  checked
                    ? availableEnvSlugs.filter((s) => pullEnvVarsBeforeBuild.includes(s))
                    : []
                );
              }}
            />
          )}
        </div>
        <div className="flex flex-col gap-2 rounded border bg-charcoal-800 p-3">
          {availableEnvSlugs.map((slug) => {
            const envType = envSlugToType(slug);
            const isPullDisabled = !pullEnvVarsBeforeBuild.includes(slug);
            return (
              <div
                key={slug}
                className={`flex items-center justify-between ${isPullDisabled ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-1.5">
                  <EnvironmentIcon environment={{ type: envType }} className="size-4" />
                  <span className={`text-sm ${environmentTextClassName({ type: envType })}`}>
                    {environmentFullTitle({ type: envType })}
                  </span>
                </div>
                <Switch
                  variant="small"
                  checked={discoverEnvVars.includes(slug)}
                  disabled={isPullDisabled}
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
          })}
        </div>
      </div>

      {/* Atomic deployments */}
      <div>
        <div className="flex items-center justify-between">
          <div>
            <Label>Atomic deployments</Label>
            <Hint>
              When enabled, production deployments wait for Vercel deployment to complete before
              promoting the Trigger.dev deployment.
            </Hint>
          </div>
          <Switch
            variant="small"
            checked={atomicBuilds.includes("prod")}
            onCheckedChange={(checked) => {
              onAtomicBuildsChange(checked ? ["prod"] : []);
            }}
          />
        </div>
      </div>
    </>
  );
}

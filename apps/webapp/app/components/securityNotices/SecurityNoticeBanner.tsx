import { useLocation, useRouteLoaderData } from "@remix-run/react";
import { AnimatedOrgBannerBar } from "~/components/billing/AnimatedOrgBannerBar";
import { LinkButton } from "~/components/primitives/Buttons";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import type { loader as environmentLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam/route";
import { v3SecurityNoticesPath } from "~/utils/pathBuilder";

const environmentRouteId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam";

export function SecurityNoticeBanner() {
  const data = useRouteLoaderData<typeof environmentLoader>(environmentRouteId);
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  const location = useLocation();

  const banner = data && "securityNoticeBanner" in data ? data.securityNoticeBanner : null;
  if (!banner || !organization || !project || !environment) return null;

  const path = v3SecurityNoticesPath(organization, project, environment);
  const onNoticePage = location.pathname === path;
  const count = banner.openEnvironmentCount;

  return (
    <AnimatedOrgBannerBar
      show
      variant="error"
      action={
        onNoticePage ? undefined : (
          <LinkButton variant="danger/small" leadingIconClassName="px-0" to={path}>
            See what to do
          </LinkButton>
        )
      }
    >
      <span className="font-medium">{banner.title}.</span> Action is needed for {count}{" "}
      {count === 1 ? "environment" : "environments"} in this project.
    </AnimatedOrgBannerBar>
  );
}

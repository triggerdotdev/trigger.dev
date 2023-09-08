import { NuxtLogo } from "~/assets/logos/NuxtLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Nuxt" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Nuxt"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev/issues/447"
      githubIssueNumber={447}
    >
      <NuxtLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

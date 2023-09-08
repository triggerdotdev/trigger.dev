import { AstroLogo } from "~/assets/logos/AstroLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Astro" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Astro"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev/issues/452"
      githubIssueNumber={452}
    >
      <AstroLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

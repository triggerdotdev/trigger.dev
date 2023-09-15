import { RedwoodLogo } from "~/assets/logos/RedwoodLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Redwood" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Redwood"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev/issues/448"
      githubIssueNumber={448}
    >
      <RedwoodLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

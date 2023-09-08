import { ExpressLogo } from "~/assets/logos/ExpressLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Express" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Express"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev/issues/451"
      githubIssueNumber={451}
    >
      <ExpressLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

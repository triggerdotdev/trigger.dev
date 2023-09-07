import { RemixLogo } from "~/assets/logos/RemixLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Remix" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Remix"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev"
      githubIssueNumber={243}
    >
      <RemixLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

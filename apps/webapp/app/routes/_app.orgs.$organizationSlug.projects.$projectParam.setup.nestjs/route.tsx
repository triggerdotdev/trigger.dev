import { NestjsLogo } from "~/assets/logos/NestjsLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Nest.js" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Nest.js"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev"
      githubIssueNumber={423}
    >
      <NestjsLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

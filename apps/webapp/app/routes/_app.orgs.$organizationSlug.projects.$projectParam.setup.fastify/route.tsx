import { FastifyLogo } from "~/assets/logos/FastifyLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Fastify" />,
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Fastify"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev"
      githubIssueNumber={245}
    >
      <FastifyLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

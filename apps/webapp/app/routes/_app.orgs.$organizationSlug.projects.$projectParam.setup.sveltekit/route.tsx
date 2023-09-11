import { SvelteKitLogo } from "~/assets/logos/SveltekitLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => (
    <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="SvelteKit" />
  ),
};

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="SvelteKit"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev/issues/453"
      githubIssueNumber={453}
    >
      <SvelteKitLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

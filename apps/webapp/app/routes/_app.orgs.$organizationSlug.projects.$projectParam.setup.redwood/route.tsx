import { RedwoodLogo } from "~/assets/logos/RedwoodLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";

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

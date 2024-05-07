import { NuxtLogo } from "~/assets/logos/NuxtLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";

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

import { FastifyLogo } from "~/assets/logos/FastifyLogo";
import { FrameworkComingSoon } from "~/components/frameworks/FrameworkComingSoon";

export default function Page() {
  return (
    <FrameworkComingSoon
      frameworkName="Fastify"
      githubIssueUrl="https://github.com/triggerdotdev/trigger.dev/issues/450"
      githubIssueNumber={450}
    >
      <FastifyLogo className="w-56" />
    </FrameworkComingSoon>
  );
}

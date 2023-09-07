import { Squares2X2Icon } from "@heroicons/react/20/solid";
import { GitHubDarkIcon } from "@trigger.dev/companyicons";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { projectSetupPath } from "~/utils/pathBuilder";
import { PageGradient } from "../PageGradient";
import { LinkButton } from "../primitives/Buttons";
import { Header1 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { NamedIcon } from "../primitives/NamedIcon";
export type FrameworkComingSoonProps = {
  frameworkName: string;
  githubIssueUrl?: string;
  githubIssueNumber?: number;
  children?: React.ReactNode;
};

export function FrameworkComingSoon({
  frameworkName,
  githubIssueUrl,
  githubIssueNumber,
  children,
}: FrameworkComingSoonProps) {
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 grid place-items-center pb-6">{children}</div>
        <div className="flex items-center justify-between">
          <Header1 spacing>{frameworkName} is coming soon!</Header1>
          <LinkButton
            to={projectSetupPath(organization, project)}
            variant="tertiary/small"
            LeadingIcon={Squares2X2Icon}
          >
            Choose a different framework
          </LinkButton>
        </div>
        <Paragraph spacing className="border-b border-slate-800 pb-4">
          We're working hard to bring support for {frameworkName} in Trigger.dev. Follow along with
          the GitHub issue or contribute and help us bring it to Trigger.dev faster.
        </Paragraph>
        <a
          href={githubIssueUrl}
          target="_blank"
          className="group mt-4 block max-w-sm rounded-md bg-bright px-10 py-8 transition hover:bg-slate-100"
        >
          <Paragraph spacing>triggerdotdev/trigger.dev</Paragraph>
          <h2 className="text-2xl font-semibold text-black">
            <span className="mr-1 font-normal text-dimmed">#{githubIssueNumber}</span>Framework:
            support for {frameworkName}
          </h2>
          <div className="mt-4 flex items-center gap-1.5">
            <GitHubDarkIcon className="h-4 w-4" />
            <Paragraph variant="small">View on GitHub</Paragraph>
            <NamedIcon
              name="arrow-right"
              className="h-4 w-4 text-dimmed transition group-hover:translate-x-1"
            />
          </div>
        </a>
      </div>
    </PageGradient>
  );
}

import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import Confetti from "react-confetti";
import { HowToSetupYourProject } from "~/components/helpContent/HelpContentText";
import { JobsTable } from "~/components/jobs/JobsTable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useFilterJobs } from "~/hooks/useFilterJobs";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import useWindowSize from "react-use/lib/useWindowSize";
import {
  docsPath,
  projectIntegrationsPath,
  trimTrailingSlash,
  ProjectParamSchema,
} from "~/utils/pathBuilder";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { requireUserId } from "~/services/session.server";
import { JobListPresenter } from "~/presenters/JobListPresenter.server";
import { TextLink } from "~/components/primitives/TextLink";
import { GitHubLightIcon, OpenAILightIcon, ResendIcon } from "@trigger.dev/companyicons";
import { ClockIcon, CalendarDaysIcon, SlackIcon } from "lucide-react";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new JobListPresenter();
    const jobs = await presenter.call({ userId, projectSlug: projectParam });

    return typedjson({
      jobs,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Jobs" />,
  expandSidebar: true,
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const { jobs } = useTypedLoaderData<typeof loader>();

  const { filterText, setFilterText, filteredItems } = useFilterJobs(jobs);

  const { width, height } = useWindowSize();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Jobs" />
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty icon={"job"} label={"Active Jobs"} value={jobs.length} />
          </PageInfoGroup>
        </PageInfoRow>
      </PageHeader>
      <PageBody>
        {/* Todo: this confetti component needs to trigger when the example project is created, then never again. */}
        {/* <Confetti
          width={width}
          height={height}
          recycle={false}
          numberOfPieces={1000}
          colors={[
            "#E7FF52",
            "#41FF54",
            "rgb(245 158 11)",
            "rgb(22 163 74)",
            "rgb(37 99 235)",
            "rgb(67 56 202)",
            "rgb(219 39 119)",
            "rgb(225 29 72)",
            "rgb(217 70 239)",
          ]}
        /> */}
        <div className="grid h-full grid-cols-1 gap-4">
          <div className="h-full">
            {jobs.length > 0 && jobs.some((j) => j.hasIntegrationsRequiringAction) && (
              <Callout
                variant="error"
                to={projectIntegrationsPath(organization, project)}
                className="mb-2"
              >
                Some of your Jobs have Integrations that have not been configured.
              </Callout>
            )}
            {jobs.length >= 1 && (
              <div className="mb-2 flex flex-col">
                <Header2 spacing>Jobs</Header2>
                <Input
                  placeholder="Search Jobs"
                  variant="tertiary"
                  icon="search"
                  fullWidth={true}
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
              </div>
            )}
            {jobs.length === 0 ? (
              <div className="grid h-full place-content-center">
                <Header1 spacing>Get setup in 5 minutes</Header1>
                <HowToSetupYourProject />
              </div>
            ) : (
              <>
                <JobsTable
                  jobs={filteredItems}
                  noResultsText={`No Jobs match ${filterText}. Try a different search
              query.`}
                />
                {jobs.length == 1 && <ExampleJobs />}
              </>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function ExampleJobs() {
  return (
    <div className="mt-6 flex w-full flex-col gap-y-2 rounded bg-slate-900 p-4">
      <Header2 className="text-slate-300">Example Jobs</Header2>
      <Paragraph variant="small">
        If you want more inspiration or just want to dig into the code of a Job, check out our{" "}
        <TextLink href="https://github.com/triggerdotdev/examples">examples repo</TextLink>.
      </Paragraph>
      <div className="h-[1px] w-full bg-slate-800" />
      <div className="flex gap-1.5">
        <ClockIcon className="h-4 w-4 pt-0.5 text-slate-100" />
        <Paragraph variant="small">
          <TextLink href="https://github.com/triggerdotdev/examples/tree/main/delays">
            Delays
          </TextLink>{" "}
          - Using delays inside Jobs
        </Paragraph>
      </div>
      <div className="flex gap-1.5">
        <CalendarDaysIcon className="h-4 w-4 pt-0.5 text-slate-100" />
        <Paragraph variant="small">
          <TextLink href="https://github.com/triggerdotdev/examples/tree/main/scheduled">
            Scheduled
          </TextLink>{" "}
          - Interval and cron scheduled Jobs
        </Paragraph>
      </div>
      <div className="flex gap-1.5">
        <GitHubLightIcon className="ml-0.5 h-4 w-4 pt-0.5" />
        <Paragraph variant="small">
          <TextLink href="https://github.com/triggerdotdev/examples/tree/main/github">
            GitHub
          </TextLink>{" "}
          - When a new GitHub issue is opened it adds a “Bug” label to it.
        </Paragraph>
      </div>
      <div className="flex gap-1.5">
        <OpenAILightIcon className="ml-0.5 h-4 w-4 pt-0.5" />
        <Paragraph variant="small">
          <TextLink href="https://github.com/triggerdotdev/examples/tree/main/openai">
            OpenAI
          </TextLink>{" "}
          - Generate images and jokes from a prompt
        </Paragraph>
      </div>
      <div className="flex gap-1.5">
        <ResendIcon className="ml-0.5 h-4 w-4 pt-0.5" />
        <Paragraph variant="small">
          <TextLink href="https://github.com/triggerdotdev/examples/tree/main/resend">
            Resend
          </TextLink>{" "}
          - Sends an email by submitting a form in the Next.js app
        </Paragraph>
      </div>{" "}
      <div className="flex gap-1.5">
        <SlackIcon className="ml-0.5 h-4 w-4 pt-0.5" />
        <Paragraph variant="small">
          <TextLink href="https://github.com/triggerdotdev/examples/tree/main/slack">
            Slack
          </TextLink>{" "}
          - Sends a Slack message when an event is received
        </Paragraph>
      </div>
    </div>
  );
}

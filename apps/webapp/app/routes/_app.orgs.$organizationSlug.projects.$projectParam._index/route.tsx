import { ArrowUpIcon } from "@heroicons/react/24/solid";
import { LoaderArgs } from "@remix-run/server-runtime";
import { GitHubLightIcon, OpenAILightIcon, ResendIcon } from "@trigger.dev/companyicons";
import { CalendarDaysIcon, ClockIcon, SlackIcon } from "lucide-react";
import useWindowSize from "react-use/lib/useWindowSize";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { HowToSetupYourProject } from "~/components/helpContent/HelpContentText";
import { JobsTable } from "~/components/jobs/JobsTable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
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
import { TextLink } from "~/components/primitives/TextLink";
import { useFilterJobs } from "~/hooks/useFilterJobs";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { JobListPresenter } from "~/presenters/JobListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import {
  ProjectParamSchema,
  projectIntegrationsPath,
  trimTrailingSlash,
} from "~/utils/pathBuilder";

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

        <Help>
          {(open) => (
            <div className={cn("grid gap-4", open ? "h-fit grid-cols-2" : " h-full grid-cols-1")}>
              <div className="h-full">
                {jobs.length > 0 ? (
                  <>
                    {jobs.some((j) => j.hasIntegrationsRequiringAction) && (
                      <Callout
                        variant="error"
                        to={projectIntegrationsPath(organization, project)}
                        className="mb-2"
                      >
                        Some of your Jobs have Integrations that have not been configured.
                      </Callout>
                    )}
                    <div className="mb-2 flex flex-col">
                      <Header2 spacing>Jobs</Header2>
                      <div className="flex w-full">
                        <Input
                          placeholder="Search Jobs"
                          variant="tertiary"
                          icon="search"
                          fullWidth={true}
                          value={filterText}
                          onChange={(e) => setFilterText(e.target.value)}
                        />
                        <HelpTrigger title="Example Jobs and inspiration" />
                      </div>
                    </div>
                    <JobsTable
                      jobs={filteredItems}
                      noResultsText={`No Jobs match ${filterText}. Try a different search
          query.`}
                    />
                    {jobs.length === 1 && jobs.every((r) => r.lastRun === undefined) && (
                      <RunYourJobPrompt />
                    )}
                  </>
                ) : (
                  <HowToSetupYourProject />
                )}
              </div>
              <HelpContent title="Example Jobs and inspiration">
                <ExampleJobs />
              </HelpContent>
            </div>
          )}
        </Help>
      </PageBody>
    </PageContainer>
  );
}

function RunYourJobPrompt() {
  return (
    <div className="mt-2 flex w-full gap-x-2 rounded border border-slate-800 bg-slate-900 p-4 pl-6">
      <ArrowUpIcon className="h-5 w-5 animate-bounce text-green-500" />
      <Paragraph variant="small" className="text-green-500">
        Your Job is ready to run! Click it to run it now.
      </Paragraph>
    </div>
  );
}

const examples = [
  {
    icon: <ClockIcon className="h-4 w-4 pt-0.5 text-slate-100" />,
    title: "Basic delay",
    description: "Logs a message to the console, waits 5 minutes, and then logs another message.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/delays/src/jobs/delayJob.ts",
  },
  {
    icon: <CalendarDaysIcon className="h-4 w-4 pt-0.5 text-slate-100" />,
    title: "Basic interval",
    description: "This Job runs every 60 seconds, starting 60 seconds after it is first indexed.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/scheduled/src/jobs/interval.ts",
  },
  {
    icon: <CalendarDaysIcon className="h-4 w-4 pt-0.5 text-slate-100" />,
    title: "Cron scheduled interval",
    description: "A scheduled Job which runs at 2:30pm every Monday.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/scheduled/src/jobs/cronScheduled.ts",
  },
  {
    icon: <OpenAILightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "OpenAI text summarizer",
    description:
      "Summarizes a block of text, pulling out the most unique / helpful points using OpenAI.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/openai-text-summarizer/src/jobs/textSummarizer.ts",
  },
  {
    icon: <OpenAILightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "Tell me a joke using OpenAI",
    description: "Generates a random joke using OpenAI GPT 3.5.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/openai/src/jobs/tellMeAJoke.ts",
  },
  {
    icon: <OpenAILightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "Generate a random image using OpenAI",
    description: "Generates a random image of a hedgehog using OpenAI DALL-E.	",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/openai/src/jobs/generateHedgehogImages.ts",
  },
  {
    icon: <ResendIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "Send an email using Resend",
    description: "Send a basic email using Resend",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/resend/src/jobs/resendBasicEmail.ts",
  },
  {
    icon: <GitHubLightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "GitHub issue reminder",
    description: "Sends a Slack message if a GitHub issue is left for 24h",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/github-issue-reminder/jobs/githubIssue.ts",
  },
  {
    icon: <GitHubLightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "Github new star alert in Slack",
    description: "When a repo is starred, a message is sent to a Slack.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/github/src/jobs/newStarToSlack.ts",
  },
  {
    icon: <GitHubLightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "Add a custom label to a GitHub issue",
    description: "When a new GitHub issue is opened it adds a “Bug” label to it.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/github/src/jobs/onIssueOpened.ts",
  },
  {
    icon: <GitHubLightIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "GitHub new star alert",
    description: "When a repo is starred a message is logged with the new Stargazers count.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/github/src/jobs/newStarAlert.ts",
  },
  {
    icon: <SlackIcon className="ml-0.5 h-4 w-4 pt-0.5" />,
    title: "Send a Slack message",
    description: "Sends a Slack message to a specific channel when an event is received.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/slack/src/jobs/sendSlackMessage.ts",
  },
];

function ExampleJobs() {
  return (
    <>
      {/* <Header2 className="text-slate-300">Useful docs links</Header2>
      <li>
        <TextLink href="https://trigger.dev/docs/documentation/guides/create-a-job">
          Create a Job in code
        </TextLink>
      </li> */}
      <Header2 className=" text-slate-300">Video walk-through</Header2>
      <div className="w-full">
        <Paragraph variant="small" className="mt-2">
          This video shows a full end-to-end example of a Job created with Trigger.dev. A GitHub
          issue reminder in Slack.
        </Paragraph>
        <iframe
          src="https://www.youtube.com/embed/uocBQt2HeQo?&showinfo=0&rel=0&modestbranding=1"
          title="Trigger.dev explainer video"
          frameBorder="0"
          width="400"
          height="250"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="py-4"
        />
      </div>
      <div className="h-[1px] w-full bg-slate-800" />

      <div className="flex w-full flex-col gap-y-2 rounded bg-slate-900 p-4">
        <Header2 className="text-slate-300">Example Jobs</Header2>
        <Paragraph variant="small">
          The best way to learn how to use Trigger.dev is to look at our{" "}
          <TextLink href="https://github.com/triggerdotdev/examples">examples repo</TextLink>. Each
          of these Jobs has it's own repo you can fork and run if you wish. See the links below for
          example Job code to use as a starting point for your projects:
        </Paragraph>
        <div className="h-[1px] w-full bg-slate-800" />
        {examples.map((example) => (
          <div key={example.title} className="flex gap-1.5">
            {example.icon}
            <Paragraph variant="small">
              <TextLink href={example.codeLink}>{example.title} </TextLink> - {example.description}{" "}
            </Paragraph>
          </div>
        ))}
      </div>
    </>
  );
}

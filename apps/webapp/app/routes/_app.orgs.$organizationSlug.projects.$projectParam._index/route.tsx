import { ArrowUpIcon } from "@heroicons/react/24/solid";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { JobsTable } from "~/components/jobs/JobsTable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { NamedIcon } from "~/components/primitives/NamedIcon";
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
import Onboarding from "../_app.orgs.$organizationSlug.projects.$projectParam.onboarding._index/route";
import FrameworksSelector from "~/components/FrameworkSelector";

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
  scripts: (match) => [
    {
      src: "https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js",
      crossOrigin: "anonymous",
    },
  ],
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const { jobs } = useTypedLoaderData<typeof loader>();

  const { filterText, setFilterText, filteredItems } = useFilterJobs(jobs);

  return (
    <PageContainer>
      {jobs.length > 0 && (
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
      )}
      <PageBody>
        <Help>
          {(open) => (
            <div className={cn("grid gap-4", open ? "h-full grid-cols-2" : " h-full grid-cols-1")}>
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
                    {jobs.length === 1 &&
                      jobs.every((r) => r.lastRun === undefined) &&
                      jobs.every((i) => i.hasIntegrationsRequiringAction === false) && (
                        <RunYourJobPrompt />
                      )}
                  </>
                ) : (
                  <FrameworksSelector />
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

function ExampleJobs() {
  return (
    <>
      <Header2 spacing>Video walk-through</Header2>
      <Paragraph spacing variant="small">
        Watch Matt, CEO of Trigger.dev create a GitHub issue reminder in Slack using Trigger.dev.
        (10 mins)
      </Paragraph>
      <iframe
        src="https://www.youtube.com/embed/uocBQt2HeQo?&showinfo=0&rel=0&modestbranding=1"
        title="Trigger.dev explainer video"
        width="400"
        height="250"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="mb-4 w-full border-b border-slate-800"
      />
      <Header2 spacing>How to create a Job</Header2>
      <Paragraph variant="small" spacing>
        Our docs are a great way to learn how to create Jobs with each type of Trigger, from
        webhooks, to delays, to triggering Jobs on a schedule.{" "}
      </Paragraph>
      <a
        href="https://trigger.dev/docs/documentation/guides/create-a-job"
        className="mb-4 flex w-full items-center rounded border-b border-slate-800 py-2 transition hover:border-transparent hover:bg-slate-800"
      >
        <NamedIcon name={"external-link"} className={iconStyles} />
        <Paragraph variant="small" className="font-semibold text-bright">
          How to create a Job
        </Paragraph>
      </a>
      <Header2 spacing>Check out some example Jobs in code</Header2>
      <Paragraph spacing variant="small">
        If you're looking for inspiration for your next Job, check out our{" "}
        <TextLink href="https://github.com/triggerdotdev/examples">examples repo</TextLink>. Or jump
        straight into an example repo from the list below:
      </Paragraph>
      <div className="flex w-full flex-col">
        {examples.map((example) => (
          <a
            href={example.codeLink}
            key={example.title}
            className="flex w-full items-center rounded border-b border-uiBorder py-2 transition hover:border-transparent hover:bg-slate-800"
          >
            {example.icon}
            <Paragraph variant="small">
              <span className="font-semibold text-bright">{example.title}</span> -{" "}
              {example.description}
            </Paragraph>
          </a>
        ))}
      </div>
    </>
  );
}

const iconStyles = "h-7 w-7 mr-2 pl-2 min-w-[28px]";

const examples = [
  {
    icon: <NamedIcon name={"clock"} className={iconStyles} />,
    title: "Basic delay",
    description: "Logs a message to the console, waits 5 minutes, and then logs another message.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/delays/src/jobs/delayJob.ts",
  },
  {
    icon: <NamedIcon name="calendar" className={iconStyles} />,
    title: "Basic interval",
    description: "This Job runs every 60 seconds, starting 60 seconds after it is first indexed.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/scheduled/src/jobs/interval.ts",
  },
  {
    icon: <NamedIcon name="calendar" className={iconStyles} />,
    title: "Cron scheduled interval",
    description: "A scheduled Job which runs at 2:30pm every Monday.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/scheduled/src/jobs/cronScheduled.ts",
  },
  {
    icon: <NamedIcon name="openai" className={iconStyles} />,
    title: "OpenAI text summarizer",
    description:
      "Summarizes a block of text, pulling out the most unique / helpful points using OpenAI.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/openai-text-summarizer/src/jobs/textSummarizer.ts",
  },
  {
    icon: <NamedIcon name="openai" className={iconStyles} />,
    title: "Tell me a joke using OpenAI",
    description: "Generates a random joke using OpenAI GPT 3.5.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/openai/src/jobs/tellMeAJoke.ts",
  },
  {
    icon: <NamedIcon name="openai" className={iconStyles} />,
    title: "Generate a random image using OpenAI",
    description: "Generates a random image of a hedgehog using OpenAI DALL-E.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/openai/src/jobs/generateHedgehogImages.ts",
  },
  {
    icon: <NamedIcon name="resend" className={iconStyles} />,
    title: "Send an email using Resend",
    description: "Send a basic email using Resend.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/resend/src/jobs/resendBasicEmail.ts",
  },
  {
    icon: <NamedIcon name="github" className={iconStyles} />,
    title: "GitHub issue reminder",
    description: "Sends a Slack message if a GitHub issue is left for 24h.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/github-issue-reminder/jobs/githubIssue.ts",
  },
  {
    icon: <NamedIcon name="github" className={iconStyles} />,
    title: "Github new star alert in Slack",
    description: "When a repo is starred, a message is sent to a Slack.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/github/src/jobs/newStarToSlack.ts",
  },
  {
    icon: <NamedIcon name="github" className={iconStyles} />,
    title: "Add a custom label to a GitHub issue",
    description: "When a new GitHub issue is opened it adds a “Bug” label to it.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/github/src/jobs/onIssueOpened.ts",
  },
  {
    icon: <NamedIcon name="github" className={iconStyles} />,
    title: "GitHub new star alert",
    description: "When a repo is starred a message is logged with the new Stargazers count.",
    codeLink: "https://github.com/triggerdotdev/examples/blob/main/github/src/jobs/newStarAlert.ts",
  },
  {
    icon: <NamedIcon name="slack" className={iconStyles} />,
    title: "Send a Slack message",
    description: "Sends a Slack message to a specific channel when an event is received.",
    codeLink:
      "https://github.com/triggerdotdev/examples/blob/main/slack/src/jobs/sendSlackMessage.ts",
  },
];

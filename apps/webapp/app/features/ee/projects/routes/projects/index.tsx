import { CheckIcon } from "@heroicons/react/20/solid";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  ClockIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  CheckCircleIcon,
  PlusCircleIcon,
  CloudIcon,
  CloudArrowUpIcon,
} from "@heroicons/react/24/solid";
import { Link, useLoaderData } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { IntlDate } from "~/components/IntlDate";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { PrimaryLink } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header2 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { requireUser } from "~/services/session.server";
import type { ProjectListItem } from "../../presenters/projectListPresenter.server";
import { ProjectListPresenter } from "../../presenters/projectListPresenter.server";

export async function loader({ params, request }: LoaderArgs) {
  const { organizationSlug } = z
    .object({ organizationSlug: z.string() })
    .parse(params);

  const user = await requireUser(request);

  if (!user.featureCloud) {
    const url = new URL(request.url);

    if (!url.pathname.endsWith("/coming-soon")) {
      return redirect(`/orgs/${organizationSlug}/projects/coming-soon`, {
        status: 302,
      });
    }
  }

  const presenter = new ProjectListPresenter();

  return typedjson(await presenter.data(user.id, organizationSlug));
}

export default function ProjectDeploysPage() {
  const { projects, appAuthorizationCount } =
    useTypedLoaderData<typeof loader>();
  const { redirectTo } = useLoaderData<typeof loader>();

  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Header context="projects" />
        <Container>
          {projects.length === 0 ? (
            <>
              <Title>Repositories</Title>
              <div className="mb-2 flex flex-col">
                {appAuthorizationCount === 0 ? (
                  <ConnectToGithub redirectTo={redirectTo} />
                ) : (
                  <AddRepo />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between">
                <Title>Repositories</Title>
                <PrimaryLink to="../projects/new">
                  <PlusIcon className="-ml-1 h-4 w-4" />
                  Add Repo
                </PrimaryLink>
              </div>
              <div className="mb-2 flex items-center justify-between">
                <SubTitle className="-mb-1">
                  {projects.length} connected repo
                  {projects.length > 1 ? "s" : ""}
                </SubTitle>
              </div>
            </>
          )}
          <List>
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectListItemView project={project} />
              </li>
            ))}
          </List>
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}

export function ProjectListItemView({ project }: { project: ProjectListItem }) {
  let Icon = ExclamationTriangleIcon;

  switch (project.status) {
    case "PENDING": {
      Icon = ClockIcon;
      break;
    }
    case "BUILDING": {
      Icon = CubeTransparentIcon;
      break;
    }
    case "DEPLOYING": {
      Icon = CloudArrowUpIcon;
      break;
    }
    case "DEPLOYED": {
      Icon = CloudIcon;
      break;
    }
    case "ERROR": {
      Icon = ExclamationTriangleIcon;
      break;
    }
  }

  return (
    <Link to={project.id} className="block transition hover:!bg-slate-850/40">
      <div className="flex flex-col flex-wrap justify-between py-4 pl-4 pr-4 lg:flex-row lg:flex-nowrap lg:items-center">
        <div className="flex flex-1 items-center justify-between">
          <div className="relative flex items-center">
            <div className="mr-4 flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-md bg-slate-850 p-3">
              <Icon className="h-12 w-12 text-slate-500" />
            </div>
            <div className="flex flex-col gap-2">
              <Header2 size="regular" className="truncate text-slate-200">
                {project.name}
              </Header2>
              <Body className="text-slate-400">#{project.branch}</Body>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                {project.status === "DEPLOYED" ? (
                  <CheckIcon className="h-4 w-4 text-green-500" />
                ) : project.status === "ERROR" ? (
                  <ExclamationTriangleIcon className="h-4 w-4 text-rose-500" />
                ) : project.status === "PENDING" ||
                  project.status === "BUILDING" ||
                  project.status === "DEPLOYING" ? (
                  <Spinner className="h-4 w-4" />
                ) : null}
                <Body className="text-slate-300">
                  {project.status.charAt(0).toUpperCase() +
                    project.status.slice(1).toLowerCase()}
                </Body>
              </div>
              <Body size="small" className="text-slate-400">
                <IntlDate date={project.createdAt} timeZone="UTC" />
              </Body>
            </div>
            <ChevronRightIcon
              className="ml-5 h-5 w-5 shrink-0 text-slate-400"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </Link>
  );
}

function ConnectToGithub({ redirectTo }: { redirectTo: string }) {
  return (
    <>
      <SubTitle className="flex items-center">
        Grant GitHub repo access to get started
      </SubTitle>
      <Panel className="mb-6">
        <div className="flex h-full flex-col items-center justify-center gap-6 py-20">
          <PrimaryLink
            size="large"
            to={`/apps/github?redirectTo=${encodeURIComponent(redirectTo)}`}
          >
            <OctoKitty className="mr-1 h-5 w-5" />
            Grant repo access
          </PrimaryLink>
          <Body size="small" className="flex items-center text-slate-400">
            To deploy a repository you need to authorize our GitHub app.{" "}
            <a
              href="https://docs.trigger.dev/faq#why-do-we-ask-for-github-access"
              target="_blank"
              rel="noreferrer"
              className="ml-1 underline decoration-slate-500 underline-offset-2 transition hover:cursor-pointer hover:text-slate-300"
            >
              Learn more.
            </a>
          </Body>
        </div>
        <div className="flex w-full flex-col items-center justify-center gap-y-4 rounded bg-slate-850/50 pt-6 pb-4">
          <div className="flex max-w-2xl flex-col items-center gap-2 text-center">
            <Body className="text-slate-400">
              Deploying a repository to the Trigger.dev Cloud (Technology
              Preview)
            </Body>
            <Body size="small" className="text-slate-500">
              Get ready for our repo hosting service! During our exclusive
              Technical Preview phase, enjoy deploying a single repo for free
              while we perfect the experience. Multiple repo support is just
              around the corner!.
            </Body>
          </div>
          <ul className="grid grid-cols-[14rem_2rem_14rem_2rem_14rem] items-center gap-4">
            <li className="flex flex-col items-center justify-start gap-3 rounded p-5 text-center">
              <OctoKitty className="h-8 w-8 opacity-70" />
              <Body className="text-slate-400" size="small">
                Grant access to a GitHub repo
              </Body>
            </li>
            <li>
              <ArrowRightIcon className="h-6 w-6 text-slate-500" />
            </li>
            <li className="flex flex-col items-center justify-start gap-3 rounded p-5 text-center">
              <PlusCircleIcon className="h-9 w-9 opacity-70" />
              <Body className="text-slate-400" size="small">
                Add a repo that contains your workflow
              </Body>
            </li>
            <li>
              <ArrowRightIcon className="h-6 w-6 text-slate-500" />
            </li>
            <li className="flex flex-col items-center justify-start gap-3 rounded p-5 text-center">
              <CloudArrowUpIcon className="h-9 w-9 opacity-70" />
              <Body className="text-slate-400" size="small">
                Deploy your repo to the Cloud
              </Body>
            </li>
          </ul>
        </div>
      </Panel>
    </>
  );
}

function AddRepo() {
  return (
    <>
      <SubTitle className="flex items-center">
        <CheckCircleIcon className="mr-1 h-6 w-6 text-green-500" />
        Your GitHub account is connected. Now add a repo.
      </SubTitle>
      <Panel className="mb-6 flex h-56 flex-col items-center justify-center gap-6">
        <PrimaryLink size="large" to="../projects/new">
          <PlusIcon className="-ml-1 h-6 w-6" />
          Add Repo
        </PrimaryLink>
      </Panel>
    </>
  );
}

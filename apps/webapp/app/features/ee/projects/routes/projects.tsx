import { CheckIcon } from "@heroicons/react/20/solid";
import {
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { IntlDate } from "~/components/IntlDate";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import {
  PrimaryLink,
  SecondaryLink,
  SecondaryA,
} from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header2 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import type { ProjectListItem } from "../presenters/projectListPresenter.server";
import { ProjectListPresenter } from "../presenters/projectListPresenter.server";

export async function loader({ params }: LoaderArgs) {
  const { organizationSlug } = z
    .object({ organizationSlug: z.string() })
    .parse(params);

  const presenter = new ProjectListPresenter();

  return typedjson(await presenter.data(organizationSlug));
}

export default function ProjectDeploysPage() {
  const { projects } = useTypedLoaderData<typeof loader>();

  return (
    <Container>
      <Title>Repositories</Title>
      {projects.length === 0 ? (
        <div className="mb-2 flex flex-col">
          <SubTitle className="mb-2">
            Add a GitHub repository to get started
          </SubTitle>
          <div className="flex gap-2">
            <PrimaryLink to="../select-repo">
              <PlusIcon className="-ml-1 h-4 w-4" />
              Add Repo
            </PrimaryLink>
            <SecondaryA
              href="https://docs.trigger.dev"
              target="_blank"
              rel="noreferrer"
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              <span>Documentation</span>
            </SecondaryA>
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-center justify-between">
          <SubTitle className="-mb-1">
            {projects.length} connected repo{projects.length > 1 ? "s" : ""}
          </SubTitle>
          <SecondaryLink to="../select-repo">
            <PlusIcon className="-ml-1 h-4 w-4" />
            Add Repo
          </SecondaryLink>
        </div>
      )}
      <List>
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectListItemView project={project} />
          </li>
        ))}
      </List>
    </Container>
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

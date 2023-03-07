import {
  ArrowTopRightOnSquareIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { IntlDate } from "~/components/IntlDate";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import { PrimaryLink, TertiaryA } from "~/components/primitives/Buttons";
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
      <>
        <div className="flex items-baseline">
          <Title>Repositories</Title>
          <PrimaryLink to="../select-repo">Add Repo</PrimaryLink>
        </div>
        <div className="mt-6 max-w-4xl">
          <div className="relative rounded-lg bg-slate-850">
            <List className="relative z-50 !mb-0">
              {projects.map((project) => (
                <ProjectListItemView key={project.id} project={project} />
              ))}
            </List>
          </div>
        </div>
      </>
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
    <Link to={project.id}>
      <li>
        <div className="flex flex-col flex-wrap justify-between py-4 pl-4 pr-4 lg:flex-row lg:flex-nowrap lg:items-center">
          <div className="flex flex-1 items-center justify-between">
            <div className="relative flex items-center">
              <div className="mr-4 h-20 w-20 flex-shrink-0 self-start rounded-md bg-slate-850 p-3">
                <Icon className="h-12 w-12 text-slate-500" />
              </div>
              <div className="flex flex-col">
                <div className="text-sm font-medium text-slate-200">
                  <TertiaryA
                    href={`https://github.com/${project.name}`}
                    target="_blank"
                  >
                    {project.name}
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  </TertiaryA>
                </div>
                <div className="text-sm font-medium text-slate-200">
                  #{project.branch}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end">
              <div className="text-sm font-medium text-slate-200">
                {project.status.toLocaleLowerCase()}
              </div>
              <div className="text-sm font-medium text-slate-200">
                <IntlDate date={project.createdAt} timeZone="UTC" />
              </div>
            </div>
          </div>
        </div>
      </li>
    </Link>
  );
}

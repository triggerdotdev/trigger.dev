import { useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema, v3WaitpointTokensPath } from "~/utils/pathBuilder";
import { CompleteWaitpointForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";
import { WaitpointDetailTable } from "~/components/runs/v3/WaitpointDetails";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { logger } from "~/services/logger.server";

const Params = EnvironmentParamSchema.extend({
  waitpointParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, waitpointParam } = Params.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  try {
    const presenter = new WaitpointPresenter();
    const result = await presenter.call({
      friendlyId: waitpointParam,
      environmentId: environment.id,
      projectId: project.id,
    });

    if (!result) {
      throw new Response(undefined, {
        status: 404,
        statusText: "Waitpoint not found",
      });
    }

    return typedjson({ waitpoint: result });
  } catch (error) {
    logger.error("Error loading waitpoint for inspector", {
      error,
      organizationSlug,
      projectParam,
      envParam,
      waitpointParam,
    });
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { waitpoint } = useTypedLoaderData<typeof loader>();

  const location = useLocation();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div
      className={cn(
        cn(
          "grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright",
          waitpoint.status === "WAITING" && "grid-rows-[2.5rem_1fr_auto]"
        )
      )}
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>{waitpoint.id}</Header2>
        <LinkButton
          to={`${v3WaitpointTokensPath(organization, project, environment)}${location.search}`}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto pt-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="px-3">
          <WaitpointDetailTable waitpoint={waitpoint} />
        </div>
        <div className="flex flex-col gap-1 pt-6">
          <div className="mb-1 flex items-center gap-1 pl-3">
            <Header3>5 related runs</Header3>
            <InfoIconTooltip content="These runs have been blocked by this waitpoint." />
          </div>
          <TaskRunsTable
            total={waitpoint.connectedRuns.length}
            hasFilters={false}
            filters={{
              tasks: [],
              versions: [],
              statuses: [],
              environments: [],
              from: undefined,
              to: undefined,
            }}
            runs={waitpoint.connectedRuns}
            isLoading={false}
            variant="bright"
          />
        </div>
      </div>
      {waitpoint.status === "WAITING" && (
        <div>
          <CompleteWaitpointForm waitpoint={waitpoint} />
        </div>
      )}
    </div>
  );
}

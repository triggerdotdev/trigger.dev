import { useNavigation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { HowToRunYourJob } from "~/components/helpContent/HelpContentText";
import { Callout } from "~/components/primitives/Callout";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { RunsTable } from "~/components/runs/RunsTable";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  JobParamsSchema,
  jobRunsParentPath,
  organizationIntegrationsPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { RunListSearchSchema } from "~/components/runs/RunStatuses";
import { RunsFilters } from "~/components/runs/RunFilters";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, projectParam, organizationSlug } = JobParamsSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new RunListPresenter();
  const list = await presenter.call({
    userId,
    filterEnvironment: searchParams.environment,
    filterStatus: searchParams.status,
    jobSlug: jobParam,
    projectSlug: projectParam,
    organizationSlug,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
    from: searchParams.from,
    to: searchParams.to,
  });

  return typedjson({
    list,
  });
};

export default function Page() {
  const { list } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();
  const user = useUser();

  return (
    <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      {job.hasIntegrationsRequiringAction && (
        <Callout variant="error" to={organizationIntegrationsPath(organization)} className="mb-2">
          {simplur`This Job has ${
            job.integrations.filter((j) => j.setupStatus === "MISSING_FIELDS").length
          } Integration[|s] that [has|have] not been configured.`}
        </Callout>
      )}
      <Help defaultOpen={list.runs.length === 0}>
        {(open) => (
          <div className={cn("grid h-fit gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
            <div>
              <div className="mb-2 flex items-center justify-between gap-x-2">
                <RunsFilters />
                <div className="flex items-center justify-end gap-x-2">
                  <HelpTrigger title="How do I run my Job?" />
                  <ListPagination list={list} />
                </div>
              </div>

              <RunsTable
                total={list.runs.length}
                hasFilters={false}
                runs={list.runs}
                isLoading={isLoading}
                runsParentPath={jobRunsParentPath(organization, project, job)}
                currentUser={user}
              />
              <ListPagination list={list} className="mt-2 justify-end" />
            </div>
            <HelpContent title="How to run your Job">
              <HowToRunYourJob />
            </HelpContent>
          </div>
        )}
      </Help>
    </div>
  );
}

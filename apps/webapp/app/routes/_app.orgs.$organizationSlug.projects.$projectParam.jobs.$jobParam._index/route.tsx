import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
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
import { RunListPresenter } from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  JobParamsSchema,
  jobRunsParentPath,
  organizationIntegrationsPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "./ListPagination";

export const DirectionSchema = z.union([z.literal("forward"), z.literal("backward")]);

export const RunListSearchSchema = z.object({
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, projectParam, organizationSlug } = JobParamsSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = RunListSearchSchema.parse(s);

  const presenter = new RunListPresenter();
  const list = await presenter.call({
    userId,
    jobSlug: jobParam,
    projectSlug: projectParam,
    organizationSlug,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
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

  return (
    <>
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
              <div className="mb-2 flex items-center justify-end gap-x-2">
                <ListPagination list={list} />
                <HelpTrigger title="How do I run my Job?" />
              </div>
              <RunsTable
                total={list.runs.length}
                hasFilters={false}
                runs={list.runs}
                isLoading={isLoading}
                runsParentPath={jobRunsParentPath(organization, project, job)}
              />
              <ListPagination list={list} className="mt-2 justify-end" />
            </div>
            <HelpContent title="How to run your Job">
              <HowToRunYourJob />
            </HelpContent>
          </div>
        )}
      </Help>
    </>
  );
}

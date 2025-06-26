import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { XCircleIcon } from "@heroicons/react/24/outline";
import { Form, useActionData, useFetcher } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/router";
import { useEffect } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { $replica, type PrismaClient } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { RunsRepository } from "~/services/runsRepository.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3RunsPath } from "~/utils/pathBuilder";

const Params = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
});

const searchParams = z.object({
  mode: z.union([z.literal("selected"), z.literal("filter")]).default("filter"),
  action: z.union([z.literal("cancel"), z.literal("replay")]).default("cancel"),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationId, projectId, environmentId } = Params.parse(params);
  const filters = await getRunFiltersFromRequest(request);
  const { mode, action } = searchParams.parse(
    Object.fromEntries(new URL(request.url).searchParams)
  );

  //todo do a ClickHouse Query with the filters
  if (!clickhouseClient) {
    throw new Error("Clickhouse client not found");
  }

  const runsRepository = new RunsRepository({
    clickhouse: clickhouseClient,
    prisma: $replica as PrismaClient,
  });

  const count = await runsRepository.countRuns({
    organizationId,
    projectId,
    environmentId,
    // ...filters,
  });

  return typedjson({
    filters,
    mode,
    action,
    count,
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const { organizationId, projectId, environmentId } = Params.parse(params);
  const filters = await getRunFiltersFromRequest(request);

  return redirectWithSuccessMessage("/", request, "SORTED");
}

export function CreateBulkActionInspector({ filters }: { filters: TaskRunListSearchFilters }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();
  const lastSubmission = useActionData<typeof action>();
  const { value } = useSearchParams();
  const location = useOptimisticLocation();

  useEffect(() => {
    fetcher.load(
      `/resources/orgs/${organization.id}/projects/${project.id}/environments/${environment.id}/runs/bulkaction${location.search}`
    );
  }, [organization.id, project.id, environment.id, location.search]);

  const mode = value("mode");
  const action = value("action");

  const data = fetcher.data != null ? fetcher.data : undefined;

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className="whitespace-nowrap">Create a bulk action</Header2>
        <LinkButton
          to={`${v3RunsPath(organization, project, environment)}${location.search}`}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Form
          method="post"
          action={`/resources/orgs/${organization.id}/projects/${project.id}/environments/${environment.id}/runs/bulkaction${location.search}`}
          className="w-full"
        >
          {data?.count}
          <Button LeadingIcon={XCircleIcon} type="submit" variant="danger/medium">
            Cancel X runs
          </Button>
        </Form>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed px-2">
        <Button
          type="submit"
          variant="tertiary/medium"
          LeadingIcon={action === "replay" ? ArrowPathIcon : XCircleIcon}
          leadingIconClassName={cn(
            "w-[1.3rem] h-[1.3rem]",
            action === "replay" ? "text-blue-400" : "text-error"
          )}
        >
          {action === "replay" ? "Replay" : "Cancel"}
        </Button>
      </div>
    </div>
  );

  // return (
  //   <Form method="post" action={`/resources/branches/archive${location.search}`} {...form.props} className="w-full">
  //     <input value={environment.id} {...conform.input(environmentId, { type: "hidden" })} />
  //     <input
  //       value={`${location.pathname}${location.search}`}
  //       {...conform.input(redirectPath, { type: "hidden" })}
  //     />
  //     <Paragraph spacing>
  //       This will <span className="text-text-bright">permanently</span> make this branch{" "}
  //       <span className="text-text-bright">read-only</span>. You won't be able to trigger runs,
  //       execute runs, or use the API for this branch.
  //     </Paragraph>
  //     <Paragraph spacing>
  //       You will still be able to view the branch and its associated runs.
  //     </Paragraph>
  //     <Paragraph spacing>Once archived you can create a new branch with the same name.</Paragraph>
  //     <FormError>{form.error}</FormError>
  //     <FormButtons
  //       confirmButton={
  //         <Button LeadingIcon={ArchiveIcon} type="submit" variant="danger/medium">
  //           Archive branch
  //         </Button>
  //       }
  //       cancelButton={
  //         <DialogClose asChild>
  //           <Button variant="tertiary/medium">Cancel</Button>
  //         </DialogClose>
  //       }
  //     />
  //   </Form>
  // );
}

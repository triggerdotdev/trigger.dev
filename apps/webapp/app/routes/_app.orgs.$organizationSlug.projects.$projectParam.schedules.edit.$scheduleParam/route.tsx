import { LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, v3ScheduleParams, v3SchedulesPath } from "~/utils/pathBuilder";
import { humanToCronSupported } from "~/v3/humanToCron.server";
import { UpsertScheduleForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.schedules.new/route";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, scheduleParam } = v3ScheduleParams.parse(params);

  const presenter = new EditSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
    friendlyId: scheduleParam,
  });

  if (result.schedule?.type === "DECLARATIVE") {
    throw redirect(v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }));
  }

  return typedjson({ ...result, showGenerateField: humanToCronSupported });
};

export default function Page() {
  const { schedule, possibleTasks, possibleEnvironments, possibleTimezones, showGenerateField } =
    useTypedLoaderData<typeof loader>();

  return (
    <UpsertScheduleForm
      schedule={schedule}
      possibleTasks={possibleTasks}
      possibleEnvironments={possibleEnvironments}
      possibleTimezones={possibleTimezones}
      showGenerateField={showGenerateField}
    />
  );
}

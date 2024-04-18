import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import { humanToCronSupported } from "~/v3/humanToCron.server";
import { UpsertScheduleForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.schedules.new/route";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const presenter = new EditSchedulePresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
  });

  return typedjson({ ...result, showGenerateField: humanToCronSupported });
};

export default function Page() {
  const { schedule, possibleTasks, possibleEnvironments, showGenerateField } =
    useTypedLoaderData<typeof loader>();

  return (
    <UpsertScheduleForm
      schedule={schedule}
      possibleTasks={possibleTasks}
      possibleEnvironments={possibleEnvironments}
      showGenerateField={showGenerateField}
    />
  );
}

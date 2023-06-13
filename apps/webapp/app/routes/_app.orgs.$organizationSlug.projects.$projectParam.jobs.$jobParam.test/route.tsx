import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { JSONEditor } from "~/components/code/JSONEditor";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { TestJobPresenter } from "~/presenters/TestJobPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { JobParamsSchema, ProjectParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, jobParam } =
    JobParamsSchema.parse(params);

  const presenter = new TestJobPresenter();
  const { environments } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    jobSlug: jobParam,
  });

  return typedjson({ environments });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "test",
  },
};

//create an Action
//save the chosen environment to a cookie (for that user), use it to default the env dropdown
//create a TestEventService class
// 1. create an EventRecord
// 2. Then use CreateRun. Update it so call can accept an optional transaction (that it uses)
// 3. It should return the run, so we can redirect to the run page

export default function Page() {
  const { environments } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  console.log(environments);

  return (
    <div>
      {/* //todo add examples dropdown */}
      <JSONEditor content={"{}"} readOnly={false} basicSetup />
      {/* //todo add environments as a dropdown next to the test button */}
    </div>
  );
}

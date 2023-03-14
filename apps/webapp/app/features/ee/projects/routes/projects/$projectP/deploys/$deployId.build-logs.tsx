import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { SecondaryLink } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { DeploymentBuildLogsPresenter } from "~/features/ee/projects/presenters/deploymentBuildLogsPresenter.server";
import { LogOutput } from "../../../../components/LogOutput";

export async function loader({ request, params }: LoaderArgs) {
  const { deployId } = z
    .object({
      deployId: z.string(),
    })
    .parse(params);

  const presenter = new DeploymentBuildLogsPresenter();

  return typedjson(await presenter.data(deployId));
}

export default function DeploymentBuildLogsPage() {
  const { deployment, logs } = useTypedLoaderData<typeof loader>();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between">
        <Header1 className="mb-6">Build Logs</Header1>
        <div className="flex gap-2">
          <SecondaryLink to={`../deploys/${deployment.id}`}>
            <ArrowLeftIcon className="-ml-1 h-4 w-4" />
            Back to Deployment
          </SecondaryLink>
        </div>
      </div>
      <SubTitle>Build: {deployment.version}</SubTitle>
      <div className="flex flex-auto overflow-auto rounded-md bg-slate-950 p-4">
        <LogOutput logs={logs} />
      </div>
    </div>
  );
}

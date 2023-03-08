import { useRevalidator } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { DeploymentPresenter } from "~/features/ee/projects/presenters/deploymentPresenter.server";

export async function loader({ request, params }: LoaderArgs) {
  const { projectP, organizationSlug, deployId } = z
    .object({
      projectP: z.string(),
      organizationSlug: z.string(),
      deployId: z.string(),
    })
    .parse(params);

  const presenter = new DeploymentPresenter();

  return typedjson(await presenter.data(organizationSlug, projectP, deployId));
}

export default function DeploymentPage() {
  const { deployment, logs } = useTypedLoaderData<typeof loader>();

  const events = useEventSource(`/resources/deploys/${deployment.id}/stream`, {
    event: "update",
  });

  const revalidator = useRevalidator();

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h1>Deployment</h1>
      <h2>
        {deployment.version} - {deployment.status} - {deployment.commitHash} -{" "}
        {deployment.commitMessage} by {deployment.committer}
      </h2>
      <pre>{logs.map((log) => `${log.level} ${log.log}`).join("\n")}</pre>
    </div>
  );
}

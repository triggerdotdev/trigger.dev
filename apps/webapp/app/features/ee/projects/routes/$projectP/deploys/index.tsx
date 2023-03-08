import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { List } from "~/components/layout/List";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentProject } from "../../$projectP";
import { DeploymentListItem } from "../../../components/DeploymentListItem";
import { DeploymentListPresenter } from "../../../presenters/deploymentListPresenter.server";

export async function loader({ params }: LoaderArgs) {
  const { projectP, organizationSlug } = z
    .object({ projectP: z.string(), organizationSlug: z.string() })
    .parse(params);

  const presenter = new DeploymentListPresenter();

  return typedjson(await presenter.data(organizationSlug, projectP));
}

export default function ProjectDeploysPage() {
  const project = useCurrentProject();
  const { deployments } = useTypedLoaderData<typeof loader>();

  // const events = useEventSource(`/resources/projects/${project.id}/deploys`, {
  //   event: "update",
  // });
  // const revalidator = useRevalidator();

  // useEffect(() => {
  //   if (events !== null) {
  //     revalidator.revalidate();
  //   }
  //   // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  // }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Title>Deploys</Title>
      <List>
        {deployments.map((deployment) => (
          <DeploymentListItem
            pathPrefix="."
            key={deployment.id}
            deployment={deployment}
            repo={project.name}
            isCurrentDeployment={
              deployment.id === project.currentDeployment?.id
            }
          />
        ))}
      </List>
    </>
  );
}

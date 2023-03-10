import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { List } from "~/components/layout/List";
import { PanelWarning } from "~/components/layout/PanelInfo";
import { TertiaryLink } from "~/components/primitives/Buttons";
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
  const { project, needsEnvVars } = useCurrentProject();
  const { deployments } = useTypedLoaderData<typeof loader>();

  return (
    <>
      <Title>Deploys</Title>
      {needsEnvVars && (
        <PanelWarning
          message="Deployments are disabled until you add the required environment variables."
          className="mb-6"
        >
          <TertiaryLink to="../settings" className="mr-1">
            Set Environment Variables
          </TertiaryLink>
        </PanelWarning>
      )}
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

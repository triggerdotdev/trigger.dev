import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CreateNewWorkflowNoWorkflows } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { getIntegrations } from "~/models/integrations.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);

  const providers = getIntegrations(false);

  return typedjson({ providers });
};

export default function NewWorkflowPage() {
  const { providers } = useTypedLoaderData<typeof loader>();

  return (
    <Container>
      <Title>New Workflow</Title>
      <SubTitle>Create a new workflow</SubTitle>
      <CreateNewWorkflowNoWorkflows providers={providers} />
    </Container>
  );
}

import { CreateNewWorkflowNoWorkflows } from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";

export default function NewWorkflowPage() {
  return (
    <Container>
      <Title>New Workflow</Title>
      <SubTitle>Create a new workflow</SubTitle>
      <CreateNewWorkflowNoWorkflows />
    </Container>
  );
}

import CreateNewWorkflow from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import {
  SideMenuContainer,
  WorkflowsSideMenu,
} from "~/components/navigation/SideMenu";

export default function NewWorkflowPage() {
  return (
    <SideMenuContainer>
      <WorkflowsSideMenu />
      <Container>
        <CreateNewWorkflow />
      </Container>
    </SideMenuContainer>
  );
}

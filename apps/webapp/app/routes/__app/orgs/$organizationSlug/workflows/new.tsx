import CreateNewWorkflow from "~/components/CreateNewWorkflow";
import { Container } from "~/components/layout/Container";
import {
  SideMenuContainer,
  WorkflowsSideMenu,
} from "~/components/navigation/SideMenu";

export default function NewWorkflowPage() {
  return (
    <Container className="w-full h-full flex items-center justify-center">
      <SideMenuContainer>
        <WorkflowsSideMenu />
        <CreateNewWorkflow />
      </SideMenuContainer>
    </Container>
  );
}

import { PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { newProjectPath } from "~/utils/pathBuilder";

export default function Page() {
  const currentOrganization = useOrganization();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title={currentOrganization.title} />
          <PageButtons>
            <LinkButton
              to={newProjectPath(currentOrganization)}
              variant="primary/small"
              shortcut="N"
            >
              Create a new project
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>
          Create new Organizations and new Projects to help organize your Jobs.
        </PageDescription>
      </PageHeader>
    </PageContainer>
  );
}

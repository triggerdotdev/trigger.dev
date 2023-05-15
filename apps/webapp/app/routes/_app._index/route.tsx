import { MainContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { PageBody } from "~/components/primitives/PageBody";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganizations } from "~/hooks/useOrganizations";
import { useOptionalUser } from "~/hooks/useUser";
import { newOrganizationPath } from "~/utils/pathBuilder";
import { OrganizationGridItem } from "./OrganizationGrid";

export default function AppLayout() {
  const organizations = useOrganizations();
  const user = useOptionalUser();

  return (
    <MainContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Your Organizations" />
          <PageButtons>
            <LinkButton
              to={newOrganizationPath()}
              variant="primary/small"
              shortcut="N"
            >
              Create a new Organization
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>
          Create new Organizations and new Projects to help organize your Jobs.
        </PageDescription>
      </PageHeader>
      <PageBody>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {organizations ? (
            <>
              {organizations.map((organization) => (
                <OrganizationGridItem
                  key={organization.id}
                  organization={organization}
                />
              ))}
            </>
          ) : (
            <li>
              <LinkButton to={newOrganizationPath()} variant="primary/small">
                Create your first organization
              </LinkButton>
            </li>
          )}
        </ul>
      </PageBody>
    </MainContainer>
  );
}

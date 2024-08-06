import { Link } from "@remix-run/react";
import simplur from "simplur";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageAccessories,
  NavBar,
  PageInfoGroup,
  PageInfoRow,
  PageTitle,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useOrganization } from "~/hooks/useOrganizations";
import { newProjectPath, projectPath } from "~/utils/pathBuilder";

export default function Page() {
  const organization = useOrganization();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`${organization.title} projects`} />
        <PageAccessories>
          <Paragraph variant="extra-small" className="text-charcoal-500">
            Org UID: {organization.id}
          </Paragraph>
          <LinkButton
            to={newProjectPath(organization)}
            variant="primary/small"
            shortcut={{ key: "n" }}
          >
            Create a new project
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {organization.projects.length > 0 ? (
            organization.projects.map((project) => {
              return (
                <li key={project.id}>
                  <Link
                    className="border-grid-bright-dimmed flex gap-4 rounded-md border p-4 transition hover:bg-charcoal-900 "
                    to={projectPath(organization, project)}
                  >
                    <NamedIcon name="folder" className="h-10 w-10 flex-none" />
                    <div className="flex flex-col">
                      <Header3>{project.name}</Header3>
                      <Badge className="max-w-max">{project.version}</Badge>
                    </div>
                  </Link>
                </li>
              );
            })
          ) : (
            <li>
              <LinkButton to={newProjectPath(organization)} variant="primary/small">
                Create a Project
              </LinkButton>
            </li>
          )}
        </ul>
      </PageBody>
    </PageContainer>
  );
}

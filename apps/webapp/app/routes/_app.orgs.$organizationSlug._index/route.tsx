import { Link } from "@remix-run/react";
import simplur from "simplur";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useOrganization } from "~/hooks/useOrganizations";
import { Handle } from "~/utils/handle";
import { newProjectPath, projectPath } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Projects" />,
};

export default function Page() {
  const organization = useOrganization();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title={`${organization.title} projects`} />
          <PageButtons>
            <LinkButton
              to={newProjectPath(organization)}
              variant="secondary/small"
              shortcut={{ key: "n" }}
            >
              Create a new project
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {organization.projects.length > 0 ? (
            organization.projects.map((project) => {
              return (
                <li key={project.id}>
                  <Link
                    className="flex gap-4 rounded-md border border-ui-border-dimmed p-4 transition hover:bg-slate-900 "
                    to={projectPath(organization, project)}
                  >
                    <NamedIcon name="folder" className="h-10 w-10 flex-none" />
                    <div className="flex flex-col">
                      <Header3>{project.name}</Header3>
                      <Paragraph variant="small">{simplur`${project.jobCount} Job[|s]`}</Paragraph>
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

import { Link, Outlet } from "@remix-run/react";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import {
  newProjectPath,
  organizationPath,
  organizationTeamPath,
  projectPath,
} from "~/utils/pathBuilder";
import { OrgAdminHeader } from "./OrgAdminHeader";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import simplur from "simplur";

export default function Page() {
  const organization = useOrganization();

  return (
    <PageContainer>
      <OrgAdminHeader />
      <PageBody>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {organization.projects.length > 0 ? (
            organization.projects.map((project) => {
              return (
                <li key={project.id}>
                  <Link
                    className="flex gap-4 rounded-md border border-slate-850 bg-slate-900 bg-gradient-to-b from-indigo-900/60 to-slate-900 to-70% p-4"
                    to={projectPath(organization, project)}
                  >
                    <NamedIcon name="folder" className="h-10 w-10 flex-none" />
                    <div className="flex flex-col">
                      <Header3>{project.name}</Header3>
                      <Paragraph variant="small">{simplur`${project._count.jobs} job[|s]`}</Paragraph>
                    </div>
                  </Link>
                </li>
              );
            })
          ) : (
            <li>
              <LinkButton
                to={newProjectPath(organization)}
                variant="primary/small"
              >
                Create a Project
              </LinkButton>
            </li>
          )}
        </ul>
      </PageBody>
    </PageContainer>
  );
}

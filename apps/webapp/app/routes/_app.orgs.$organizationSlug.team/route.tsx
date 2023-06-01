import { Outlet } from "@remix-run/react";
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
} from "~/utils/pathBuilder";
import { OrgAdminHeader } from "../_app.orgs.$organizationSlug._index/OrgAdminHeader";

export default function Page() {
  const organization = useOrganization();

  return (
    <PageContainer>
      <OrgAdminHeader />
      <PageBody>Team will go here</PageBody>
    </PageContainer>
  );
}

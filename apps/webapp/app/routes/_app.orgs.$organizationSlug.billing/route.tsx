import { ComingSoon } from "~/components/ComingSoon";
import { PageContainer, PageBody } from "~/components/layout/AppLayout";
import { OrgAdminHeader } from "../_app.orgs.$organizationSlug._index/OrgAdminHeader";

export default function Page() {
  return (
    <PageContainer>
      <OrgAdminHeader />
      <PageBody>
        <ComingSoon
          title="Usage & billing"
          description="View your usage, tier and billing information. During the beta we will display usage and start billing if you exceed your limits. But don't worry, we'll give you plenty of warning."
          icon="billing"
        />
      </PageBody>
    </PageContainer>
  );
}

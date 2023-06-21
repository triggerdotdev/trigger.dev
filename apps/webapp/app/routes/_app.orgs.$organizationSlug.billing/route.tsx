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
          description="View your usage, tier and billing information. During the v2 beta we will expose usage and start billing."
          icon="billing"
        />
      </PageBody>
    </PageContainer>
  );
}

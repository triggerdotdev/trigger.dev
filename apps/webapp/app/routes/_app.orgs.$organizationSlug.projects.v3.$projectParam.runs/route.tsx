import { Outlet } from "@remix-run/react";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { PageHeader, PageTitle, PageTitleRow } from "~/components/primitives/PageHeader";

export default function Page() {
  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title="Runs" />
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}

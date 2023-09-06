import { Outlet } from "@remix-run/react";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/NavBar";
import {
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Handle } from "~/utils/handle";
import { trimTrailingSlash } from "~/utils/pathBuilder";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={trimTrailingSlash(match.pathname)} title="Triggers" />,
};

export default function Page() {
  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title="Onboarding" />
        </PageTitleRow>
        <PageDescription>Onboarding</PageDescription>
      </PageHeader>

      <PageBody scrollable={false}>
        <div className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
          <Outlet />
        </div>
      </PageBody>
    </PageContainer>
  );
}

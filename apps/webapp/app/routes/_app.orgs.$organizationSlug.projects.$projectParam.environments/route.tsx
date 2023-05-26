import { PageContainer } from "~/components/layout/AppLayout";
import {
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: {
    slug: "environments",
  },
};

export default function Page() {
  const currentProject = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environments" />
        </PageTitleRow>
        {/* <PageDescription>XX active Jobs</PageDescription> */}
      </PageHeader>
    </PageContainer>
  );
}

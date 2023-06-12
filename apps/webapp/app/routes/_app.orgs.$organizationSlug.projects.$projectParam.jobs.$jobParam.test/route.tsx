import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: {
    slug: "test",
  },
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();

  return <div>Test page</div>;
}

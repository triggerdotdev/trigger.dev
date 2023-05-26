import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";

//todo defer the run list query
//todo live show when there are new items in the list

export const handle: Handle = {
  breadcrumb: {
    slug: "runs",
  },
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();

  return <div>Runs page</div>;
}

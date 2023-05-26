import invariant from "tiny-invariant";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { useCurrentProject } from "~/hooks/useProject";
import { Handle } from "~/utils/handle";

//todo defer the run list query
//todo live show when there are new items in the list

export const handle: Handle = {
  breadcrumb: {
    slug: "runs",
  },
};

export default function Page() {
  const organization = useCurrentOrganization();
  const project = useCurrentProject();
  invariant(project, "Project must be defined");
  invariant(organization, "Organization must be defined");

  return <div>Runs page</div>;
}

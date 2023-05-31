import { LoaderArgs, json } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { useOptionalOrganizations } from "~/hooks/useOrganizations";
import { getOrganizations } from "~/models/organization.server";
import { requireUserId } from "~/services/session.server";
import { newOrganizationPath } from "~/utils/pathBuilder";
import { OrganizationGridItem } from "./OrganizationGrid";

export const loader = async ({ request }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const organizations = await getOrganizations({ userId });
  if (organizations.length === 0) {
    return redirect(newOrganizationPath());
  }
  return json({});
};

export default function Page() {
  const organizations = useOptionalOrganizations();

  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {organizations && organizations.length > 0 ? (
        <>
          {organizations.map((organization) => (
            <OrganizationGridItem
              key={organization.id}
              organization={organization}
            />
          ))}
        </>
      ) : (
        <li>
          <LinkButton to={newOrganizationPath()} variant="primary/small">
            Create your first organization
          </LinkButton>
        </li>
      )}
    </ul>
  );
}

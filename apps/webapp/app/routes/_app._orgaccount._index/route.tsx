import { LoaderArgs, json } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { useOptionalOrganizations } from "~/hooks/useOrganizations";
import { getOrganizations } from "~/models/organization.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { invitesPath, newOrganizationPath } from "~/utils/pathBuilder";
import { OrganizationGridItem } from "./OrganizationGrid";
import { getUsersInvites } from "~/models/member.server";

export const loader = async ({ request }: LoaderArgs) => {
  const user = await requireUser(request);

  //todo
  //if the user hasn't confirmed their name, then redirect to the confirm name page

  //if there are invites then we should redirect to the invites page
  const invites = await getUsersInvites({ email: user.email });
  if (invites.length > 0) {
    return redirect(invitesPath());
  }

  //if there are no orgs, then redirect to create an org
  const organizations = await getOrganizations({ userId: user.id });
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

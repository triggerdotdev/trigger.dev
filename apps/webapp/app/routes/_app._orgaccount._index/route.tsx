import { LoaderArgs, json } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { LinkButton } from "~/components/primitives/Buttons";
import { useOptionalOrganizations } from "~/hooks/useOrganizations";
import { getUsersInvites } from "~/models/member.server";
import { getOrganizations } from "~/models/organization.server";
import { requireUser } from "~/services/session.server";
import { invitesPath, newOrganizationPath } from "~/utils/pathBuilder";
import { OrganizationGridItem } from "./OrganizationGrid";
import { Link } from "@remix-run/react";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";

export const loader = async ({ request }: LoaderArgs) => {
  const user = await requireUser(request);

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
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,_minmax(350px,_auto))]">
      <>
        {organizations &&
          organizations.map((organization) => (
            <OrganizationGridItem
              key={organization.id}
              organization={organization}
            />
          ))}
      </>
      <li>
        <Link
          to={newOrganizationPath()}
          className="group grid h-full grow place-items-center rounded-md border border-slate-800 p-2 shadow-sm shadow-transparent transition duration-300 hover:border-indigo-900 hover:shadow-glow-secondary"
        >
          <div className="flex flex-col items-center justify-center gap-y-2">
            <NamedIcon
              name="plus"
              className="h-10 w-10 text-dimmed transition duration-300 group-hover:text-green-500"
              aria-hidden="true"
            />
            <Paragraph
              variant="small"
              className="transition duration-300 group-hover:text-bright"
            >
              New Organization
            </Paragraph>
          </div>
        </Link>
      </li>
    </ul>
  );
}

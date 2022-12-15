import { Link } from "@remix-run/react";
import { useOrganizations } from "~/hooks/useOrganizations";
import type { Organization } from "~/models/organization.server";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <div className="flex items-center justify-center p-12 ">
        <ul className="grid grid-cols-3 max-w-5xl gap-2">
          {organizations ? (
            <OrganizationGrid organizations={organizations} />
          ) : (
            <li>No organizations</li>
          )}
          <li>
            <Link to="orgs/new" className={boxClasses}>
              Create a new organization
            </Link>
          </li>
        </ul>
      </div>
    </>
  );
}

function OrganizationGrid({
  organizations,
}: {
  organizations: Organization[];
}) {
  return (
    <>
      {organizations.map((organization) => (
        <OrganizationGridItem
          key={organization.id}
          organization={organization}
        />
      ))}
    </>
  );
}

const boxClasses = "rounded bg-slate-800 px-6 py-5 shadow-sm";

function OrganizationGridItem({
  organization,
}: {
  organization: Organization;
}) {
  return (
    <li key={organization.id}>
      <Link to={`orgs/${organization.slug}`} className={boxClasses}>
        {organization.title}{" "}
      </Link>
    </li>
  );
}

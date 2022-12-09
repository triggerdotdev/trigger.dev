import { Link } from "@remix-run/react";
import { Header } from "~/components/Header";
import { AppBody } from "~/components/layout/AppLayout";
import { useOrganizations } from "~/hooks/useOrganizations";
import type { Organization } from "~/models/organization.server";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <Header />
      <AppBody>
        <div className="flex items-center justify-center p-12 ">
          <ul className="grid grid-cols-3 max-w-5xl gap-2">
            {organizations ? (
              <OrganizationGrid organizations={organizations} />
            ) : (
              <li>No organizations</li>
            )}
            <li className={boxClasses}>
              <Link to="orgs/new">Create a new organization</Link>
            </li>
          </ul>
        </div>
      </AppBody>
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

const boxClasses =
  "rounded-lg border border-gray-300 bg-white px-6 py-5 shadow-sm";

function OrganizationGridItem({
  organization,
}: {
  organization: Organization;
}) {
  return (
    <li key={organization.id} className={boxClasses}>
      <Link to={`orgs/${organization.slug}`}>{organization.title}</Link>
    </li>
  );
}

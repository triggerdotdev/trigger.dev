import { BookmarkIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Body } from "~/components/primitives/text/Body";
import { useOrganizations } from "~/hooks/useOrganizations";
import type { Organization } from "~/models/organization.server";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <div className="flex items-center justify-center m-20">
        <ul className="grid grid-cols-3 max-w-8xl gap-2">
          {organizations ? (
            <OrganizationGrid organizations={organizations} />
          ) : (
            <li>
              <Body>No organizations</Body>
            </li>
          )}
          <li>
            <Link
              to="orgs/new"
              className={classNames(
                "border-2 border-slate-800 hover:border-transparent hover:bg-slate-800/50 hover:shadow-md",
                boxClasses
              )}
            >
              <PlusIcon className="h-10 w-10 text-green-500" />
              New Organization
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

const boxClasses =
  "flex flex-col gap-4 items-center min-h-40 rounded-lg px-20 py-20 transition";

function OrganizationGridItem({
  organization,
}: {
  organization: Organization;
}) {
  return (
    <li key={organization.id} className="w-full h-full">
      <Link
        to={`orgs/${organization.slug}`}
        className={classNames(
          "bg-slate-800 shadow-md hover:bg-slate-800/50",
          boxClasses
        )}
      >
        <BookmarkIcon className="h-10 w-10" />
        {organization.title}{" "}
      </Link>
    </li>
  );
}

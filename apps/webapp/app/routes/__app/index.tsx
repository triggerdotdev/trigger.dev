import {
  BookmarkIcon,
  BuildingOffice2Icon,
  PlusIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Body } from "~/components/primitives/text/Body";
import { useOrganizations } from "~/hooks/useOrganizations";
import type { Organization } from "~/models/organization.server";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <div className="m-20 flex items-center justify-center">
        <ul className="max-w-8xl grid grid-cols-2 gap-2  md:grid-cols-3 lg:grid-cols-4">
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
                "border-2 border-slate-800 text-center hover:border-transparent hover:bg-slate-800/50 hover:shadow-md",
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
  "flex flex-col gap-4 items-center justify-center min-h-40 rounded-lg px-6 py-6 min-h-[15rem] transition";

function OrganizationGridItem({
  organization,
}: {
  organization: Organization;
}) {
  return (
    <li key={organization.id} className="h-full w-full">
      <Link
        to={`orgs/${organization.slug}`}
        className={classNames(
          "bg-slate-800 text-center shadow-md hover:bg-slate-800/50",
          boxClasses
        )}
      >
        {organization.title === "Personal Workspace" ? (
          <UserIcon className="h-10 w-10 text-slate-300" aria-hidden="true" />
        ) : (
          <BuildingOffice2Icon
            className="h-10 w-10 text-blue-500"
            aria-hidden="true"
          />
        )}
        {organization.title}
      </Link>
    </li>
  );
}

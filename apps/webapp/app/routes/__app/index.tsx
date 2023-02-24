import {
  BuildingOffice2Icon,
  PlusIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { CopyTextPanel } from "~/components/CopyTextButton";
import { Body } from "~/components/primitives/text/Body";
import { Header4 } from "~/components/primitives/text/Headers";
import type { MatchedOrganization } from "~/hooks/useOrganizations";
import { useOrganizations } from "~/hooks/useOrganizations";
import { environmentShortName, obfuscateApiKey } from "~/utils";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <div className="flex h-80 w-full items-center justify-center bg-slate-900/50">
        <h1 className="relative bottom-6 text-4xl text-slate-400">
          Your Organizations
        </h1>
      </div>
      <div className="flex items-center justify-center">
        <ul className="-mt-20 grid max-w-7xl grid-cols-2 gap-2 lg:grid-cols-3">
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
                "h-full border-2 border-slate-800 hover:border-transparent hover:bg-slate-800 hover:shadow-md",
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
  organizations: MatchedOrganization[];
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

function OrganizationGridItem({
  organization,
}: {
  organization: MatchedOrganization;
}) {
  return (
    <li key={organization.id} className="h-full w-full">
      <Link
        to={`orgs/${organization.slug}`}
        className={classNames(
          "bg-slate-800 hover:bg-[rgb(33,43,59)]",
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
        <Header4 className="mb-6">{organization.title}</Header4>
        <div className="flex w-full flex-col gap-1">
          {organization.environments.map((environment) => (
            <div
              key={environment.id}
              className="flex w-full items-center gap-0.5"
            >
              <Body
                size="extra-small"
                className="-rotate-90 uppercase tracking-wider text-slate-500"
              >
                {environmentShortName(environment.slug)}
              </Body>
              <CopyTextPanel
                value={environment.apiKey}
                text={obfuscateApiKey(environment.apiKey)}
                variant="slate"
                className="w-[calc(100%-1.8rem)] min-w-[calc(100%-1.8rem)] text-slate-400"
              />
            </div>
          ))}
        </div>
      </Link>
    </li>
  );
}

const boxClasses =
  "flex flex-col gap-4 w-80 text-center shadow-md items-center justify-center rounded-lg pl-2 pr-4 pb-4 pt-12 min-h-full transition";

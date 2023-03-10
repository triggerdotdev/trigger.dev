import {
  BuildingOffice2Icon,
  PlusIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { CopyTextPanel } from "~/components/CopyTextButton";
import { AppBody } from "~/components/layout/AppLayout";
import { Header } from "~/components/layout/Header";
import { Body } from "~/components/primitives/text/Body";
import { Header4 } from "~/components/primitives/text/Headers";
import { Tooltip } from "~/components/primitives/Tooltip";
import type { MatchedOrganization } from "~/hooks/useOrganizations";
import { useOrganizations } from "~/hooks/useOrganizations";
import { environmentShortName } from "~/utils";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <AppBody>
        <Header />
        <div className="flex h-80 w-full items-center justify-center bg-slate-900/50">
          <h1 className="relative bottom-6 text-4xl text-slate-400">
            Your Organizations
          </h1>
        </div>
        <div className="flex items-center justify-center">
          <ul className="-mt-24 grid max-w-7xl grid-cols-2 gap-2 lg:grid-cols-3">
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
                  "h-full border border-slate-700 hover:border-transparent hover:bg-[rgb(38,51,71)] hover:shadow-md",
                  boxClasses
                )}
              >
                <PlusIcon className="h-10 w-10 text-green-500" />
                <Header4 size="small" className="mb-10">
                  New Organization
                </Header4>
              </Link>
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
          "border border-slate-700 bg-slate-800 hover:bg-[rgb(38,51,71)]",
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
        <Header4 size="large" className="mb-10 text-slate-300">
          {organization.title}
        </Header4>

        <div className="grid w-full grid-cols-2 gap-2">
          {organization.environments.map((environment) => (
            <div key={environment.id} className="flex w-full items-center">
              <div className="w-full">
                <Tooltip
                  key={environment.id}
                  text={
                    environment.slug === "live"
                      ? "Use in live / production"
                      : "Use in dev / local"
                  }
                >
                  <CopyTextPanel
                    value={environment.apiKey}
                    text={`${environmentShortName(environment.slug)} API Key`}
                    variant="slate"
                    className=" text-slate-500"
                  />
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      </Link>
    </li>
  );
}

const boxClasses =
  "flex flex-col gap-4 w-80 text-center shadow-md items-center justify-center rounded-lg px-2 pb-2 pt-14 min-h-full transition";

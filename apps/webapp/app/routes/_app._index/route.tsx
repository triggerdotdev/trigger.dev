import {
  BuildingOffice2Icon,
  PlusIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { MainContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import {
  PageButtons,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import type { MatchedOrganization } from "~/hooks/useOrganizations";
import { useOrganizations } from "~/hooks/useOrganizations";
import { useOptionalUser } from "~/hooks/useUser";
import { cn } from "~/utils/cn";
import { newOrganizationPath, organizationPath } from "~/utils/pathBuilder";

export default function AppLayout() {
  const organizations = useOrganizations();
  const user = useOptionalUser();

  return (
    <MainContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle
            title="Your Organizations"
            backButton={{ to: "/", text: "Orgs" }}
          />
          <PageButtons>
            <LinkButton
              to={newOrganizationPath()}
              variant="primary/small"
              shortcut="N"
            >
              Create a new Organization
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
      </PageHeader>

      <div className="z-10 mb-12 flex items-center justify-center">
        <ul className="grid max-w-7xl grid-cols-2 gap-2 lg:grid-cols-3">
          {organizations ? (
            <OrganizationGrid organizations={organizations} />
          ) : (
            <li>
              <Paragraph>No organizations</Paragraph>
            </li>
          )}
          <li>
            <Link
              to={newOrganizationPath()}
              className={cn(
                "h-full border border-slate-700 hover:border-transparent hover:bg-[rgb(38,51,71)] hover:shadow-md",
                boxClasses
              )}
            >
              <PlusIcon className="h-10 w-10 text-green-500" />
              <Header3 className="mb-10">New Organization</Header3>
            </Link>
          </li>
        </ul>
      </div>
    </MainContainer>
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
        to={organizationPath(organization)}
        className={cn(
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
        <Header3 className="mb-16 text-slate-300">{organization.title}</Header3>
      </Link>
    </li>
  );
}

const boxClasses =
  "flex flex-col gap-4 w-80 text-center shadow-md items-center justify-center rounded-lg px-2 pb-2 pt-16 min-h-full transition";

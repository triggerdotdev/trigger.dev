import { BuildingOffice2Icon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import type { MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { projectPath } from "~/utils/pathBuilder";

export function OrganizationGridItem({
  organization,
}: {
  organization: MatchedOrganization;
}) {
  return (
    <li key={organization.id}>
      <div
        className={cn(
          "to-50% block rounded-md border border-slate-850 bg-gradient-to-b from-indigo-900/50 to-slate-950 p-2 "
        )}
      >
        <div className="flex gap-4 border-b border-slate-850 px-2 pb-4 pt-2">
          <BuildingOffice2Icon
            className="h-10 w-10 flex-none text-fuchsia-600"
            aria-hidden="true"
          />
          <div className="flex-1">
            <Header2 className="">{organization.title}</Header2>
            <Paragraph variant="extra-small">1 team member</Paragraph>
          </div>
        </div>
        <div className="pt-4">
          <Paragraph variant="extra-small/bright/caps">Projects</Paragraph>
          <div>
            {organization.projects.map((project) => (
              <LinkButton
                variant="menu-item"
                to={projectPath(organization, project)}
                key={project.id}
              >
                {project.name}
              </LinkButton>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

import { BuildingOffice2Icon } from "@heroicons/react/24/solid";
import simplur from "simplur";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import type { MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { newProjectPath, projectPath } from "~/utils/pathBuilder";

export function OrganizationGridItem({
  organization,
}: {
  organization: MatchedOrganization;
}) {
  return (
    <li key={organization.id}>
      <div
        className={cn(
          "to-70% block rounded-md border border-slate-850 bg-gradient-to-b from-indigo-900/50 to-slate-950 p-2 "
        )}
      >
        <div className="flex gap-4 border-b border-slate-850 px-2 pb-4 pt-2">
          <BuildingOffice2Icon
            className="h-10 w-10 flex-none text-fuchsia-600"
            aria-hidden="true"
          />
          <div className="flex-1">
            <Header2 className="">{organization.title}</Header2>
            <Paragraph variant="extra-small">
              {simplur`${organization._count.members} team member[|s]`}
            </Paragraph>
          </div>
        </div>
        <div className="py-4">
          <Paragraph className="mb-2 px-2" variant="extra-small/bright/caps">
            Projects
          </Paragraph>
          <div>
            {organization.projects.map((project) => (
              <LinkButton
                variant="menu-item"
                to={projectPath(organization, project)}
                key={project.id}
                LeadingIcon="folder"
                fullWidth
                textAlignLeft
              >
                <span className="flex grow items-center justify-between pl-1">
                  <span className="grow text-left">{project.name}</span>
                  <Badge>{simplur`${project._count.jobs} job[|s]`}</Badge>
                </span>
              </LinkButton>
            ))}
            <LinkButton
              to={newProjectPath(organization)}
              variant="menu-item"
              LeadingIcon="plus"
              fullWidth
              textAlignLeft
            >
              New Project
            </LinkButton>
          </div>
        </div>
      </div>
    </li>
  );
}

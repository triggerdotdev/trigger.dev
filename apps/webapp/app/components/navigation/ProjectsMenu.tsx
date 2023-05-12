import { Link } from "@remix-run/react";
import { useState } from "react";
import {
  useCurrentOrganization,
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverSectionHeader,
} from "../primitives/Popover";
import { LinkButton } from "../primitives/Buttons";
import { FolderIcon, PlusIcon } from "@heroicons/react/24/solid";

export function ProjectsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();
  const isNewOrgPage = useIsNewOrganizationPage();

  if (organizations === undefined || isNewOrgPage) {
    return null;
  }

  return (
    <>
      <Popover onOpenChange={(open) => setIsOpen(open)}>
        <PopoverArrowTrigger isOpen={isOpen}>
          {currentOrganization?.title ?? "Select an organization"}
        </PopoverArrowTrigger>
        <PopoverContent className="w-80 p-0">
          {organizations.map((organization) => (
            <div key={organization.id}>
              <PopoverSectionHeader title={organization.title} />

              <div className="flex flex-col gap-1">
                {organization.projects.map((project) => (
                  //todo change to use "folder" named icon and the new variant
                  <LinkButton
                    key={project.id}
                    to={`/orgs/${organization.slug}/project/${project.id}`}
                    text={project.name}
                    size={"medium"}
                    theme={"secondary"}
                    LeadingIcon={FolderIcon}
                  />
                ))}
                <LinkButton
                  to={`/orgs/${organization.slug}/project/new`}
                  text="New Project"
                  size={"medium"}
                  theme={"secondary"}
                  LeadingIcon={PlusIcon}
                />
              </div>
            </div>
          ))}
          <div className="border-t border-slate-700">
            <LinkButton
              to={`/orgs/new`}
              text="New Organization"
              size={"medium"}
              theme={"secondary"}
              LeadingIcon={PlusIcon}
            />
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

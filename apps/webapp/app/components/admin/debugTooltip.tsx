import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useIsImpersonating, useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { useHasAdminAccess, useUser } from "~/hooks/useUser";

export function AdminDebugTooltip({ children }: { children?: React.ReactNode }) {
  const hasAdminAccess = useHasAdminAccess();
  const isImpersonating = useIsImpersonating();

  if (!hasAdminAccess && !isImpersonating) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <ShieldCheckIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent className="max-h-[90vh] overflow-y-auto">
          <Content>{children}</Content>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Content({ children }: { children: React.ReactNode }) {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const user = useUser();

  return (
    <div className="flex flex-col gap-2 divide-y divide-slate-700">
      <Property.Table>
        <Property.Item>
          <Property.Label>User ID</Property.Label>
          <Property.Value>{user.id}</Property.Value>
        </Property.Item>
        {organization && (
          <Property.Item>
            <Property.Label>Org ID</Property.Label>
            <Property.Value>{organization.id}</Property.Value>
          </Property.Item>
        )}
        {project && (
          <>
            <Property.Item>
              <Property.Label>Project ID</Property.Label>
              <Property.Value>{project.id}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Project ref</Property.Label>
              <Property.Value>{project.externalRef}</Property.Value>
            </Property.Item>
          </>
        )}
      </Property.Table>
      <div className="pt-2">{children}</div>
    </div>
  );
}

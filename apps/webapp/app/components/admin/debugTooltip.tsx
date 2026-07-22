import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { CopyableText } from "~/components/primitives/CopyableText";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
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
        {/* The copy controls below pass `hideTooltip` so their own tooltips don't fire
            Radix's global close and dismiss this panel. `pr-8` leaves room for the
            copy button, which is absolutely positioned to the right of each value. */}
        <TooltipContent className="max-h-[90vh] overflow-y-auto pr-8">
          <Content>{children}</Content>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Content({ children }: { children: React.ReactNode }) {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  const user = useUser();

  return (
    <div className="flex flex-col gap-2 divide-y divide-slate-700">
      <Property.Table>
        <Property.Item>
          <Property.Label>User ID</Property.Label>
          <Property.Value>
            <CopyableText value={user.id} asChild hideTooltip />
          </Property.Value>
        </Property.Item>
        {organization && (
          <Property.Item>
            <Property.Label>Org ID</Property.Label>
            <Property.Value>
              <CopyableText value={organization.id} asChild hideTooltip />
            </Property.Value>
          </Property.Item>
        )}
        {project && (
          <>
            <Property.Item>
              <Property.Label>Project ID</Property.Label>
              <Property.Value>
                <CopyableText value={project.id} asChild hideTooltip />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Project ref</Property.Label>
              <Property.Value>
                <CopyableText value={project.externalRef} asChild hideTooltip />
              </Property.Value>
            </Property.Item>
          </>
        )}
        {environment && (
          <>
            <Property.Item>
              <Property.Label>Environment ID</Property.Label>
              <Property.Value>
                <CopyableText value={environment.id} asChild hideTooltip />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Environment type</Property.Label>
              <Property.Value>{environment.type}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Environment paused</Property.Label>
              <Property.Value>{environment.paused ? "Yes" : "No"}</Property.Value>
            </Property.Item>
          </>
        )}
      </Property.Table>
      {children && <div className="pt-2">{children}</div>}
    </div>
  );
}

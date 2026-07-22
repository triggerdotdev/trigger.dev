import { ShieldCheckIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useIsImpersonating, useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { useHasAdminAccess, useUser } from "~/hooks/useUser";

export function AdminDebugTooltip({ children }: { children?: React.ReactNode }) {
  const hasAdminAccess = useHasAdminAccess();
  const isImpersonating = useIsImpersonating();
  const [open, setOpen] = useState(false);
  const closeTimeout = useRef<ReturnType<typeof setTimeout>>();

  // Clean up any pending close timer on unmount.
  useEffect(() => () => clearTimeout(closeTimeout.current), []);

  if (!hasAdminAccess && !isImpersonating) {
    return null;
  }

  const openNow = () => {
    clearTimeout(closeTimeout.current);
    setOpen(true);
  };

  // Delay closing so moving the pointer across the gap into the popover — or onto a
  // copy button that opens its own tooltip — doesn't dismiss it. This is a Popover
  // rather than a Tooltip on purpose: Radix tooltips only allow one open at a time, so
  // a copy button's tooltip would otherwise close this panel.
  const closeSoon = () => {
    clearTimeout(closeTimeout.current);
    closeTimeout.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="Admin debug info"
        className="flex items-center outline-hidden focus-custom"
        onClick={(e) => e.preventDefault()}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onFocus={openNow}
        onBlur={closeSoon}
      >
        <ShieldCheckIcon className="size-5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[90vh] overflow-y-auto px-3 py-2 pr-8 text-sm"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
      >
        <Content>{children}</Content>
      </PopoverContent>
    </Popover>
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
            <CopyableText value={user.id} asChild />
          </Property.Value>
        </Property.Item>
        {organization && (
          <Property.Item>
            <Property.Label>Org ID</Property.Label>
            <Property.Value>
              <CopyableText value={organization.id} asChild />
            </Property.Value>
          </Property.Item>
        )}
        {project && (
          <>
            <Property.Item>
              <Property.Label>Project ID</Property.Label>
              <Property.Value>
                <CopyableText value={project.id} asChild />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Project ref</Property.Label>
              <Property.Value>
                <CopyableText value={project.externalRef} asChild />
              </Property.Value>
            </Property.Item>
          </>
        )}
        {environment && (
          <>
            <Property.Item>
              <Property.Label>Environment ID</Property.Label>
              <Property.Value>
                <CopyableText value={environment.id} asChild />
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
      <div className="pt-2">{children}</div>
    </div>
  );
}

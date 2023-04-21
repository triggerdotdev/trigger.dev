import type { ExternalAPI } from "~/services/externalApis/types";
import { NamedIcon } from "../Icon";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../primitives/Sheet";

export type Status = "loading" | "idle";

export function ConnectButton({
  api,
  organizationId,
  children,
  className,
}: {
  api: ExternalAPI;
  organizationId: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Sheet>
      <SheetTrigger>{children}</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Are you sure absolutely sure?</SheetTitle>
          <SheetDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}

export function BasicConnectButton({
  api,
  organizationId,
}: {
  api: ExternalAPI;
  organizationId: string;
}) {
  return (
    <ConnectButton
      api={api}
      organizationId={organizationId}
      className="flex items-center gap-3 rounded bg-indigo-700 py-2 pl-3 pr-4 text-sm text-white shadow-md transition hover:bg-indigo-600 disabled:opacity-50"
    >
      <>
        <NamedIcon name={api.identifier} className={"h-8 w-8"} />
        <span>Connect to {api.name}</span>
      </>
    </ConnectButton>
  );
}

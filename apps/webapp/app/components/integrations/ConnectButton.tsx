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
import { PrimaryButton } from "../primitives/Buttons";
import { Form } from "@remix-run/react";
import { Header3 } from "../primitives/text/Headers";

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
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Select the scopes for {api.name}</SheetTitle>
          <SheetDescription>
            <p>
              Select the scopes you want to grant to {api.name} to access your
              data. If you try and perform an action in a Job that requires a
              scope you haven't granted, that task will fail.
            </p>
          </SheetDescription>
        </SheetHeader>
        <Form
          method="post"
          action="/api/v3/oauth2"
          className="flex flex-grow flex-col"
        >
          <Header3>Select scopes</Header3>
          <div className="flex-grow overflow-y-auto">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="api" value={api.identifier} />
            <input
              type="hidden"
              name="authenticationMethodKey"
              value={Object.keys(api.authenticationMethods)[0]}
            />
            {Object.values(api.authenticationMethods)[0].scopes.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={`scopes[${s.name}]`}
                  defaultChecked={true}
                />
                <label htmlFor={`scopes[${s.name}]`}>{s.name}</label>
              </div>
            ))}
          </div>
          <div>
            <PrimaryButton type="submit" className="flex gap-2">
              <NamedIcon name={api.identifier} className="h-4 w-4" />{" "}
              <span>Connect to {api.name}</span>
            </PrimaryButton>
          </div>
        </Form>
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

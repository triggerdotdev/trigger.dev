import { useLocation, useTransition } from "@remix-run/react";
import classNames from "classnames";
import { useTypedFetcher } from "remix-typedjson";
import type { action } from "~/routes/resources/connection/oauth2";
import type { ExternalApi } from "~/services/externalApis/types";
import { NamedIcon } from "../primitives/NamedIcon";
import { PrimaryButton } from "../primitives/Buttons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../primitives/Sheet";
import { Header3 } from "../primitives/Headers";
import { Input } from "../primitives/Input";
import { Badge } from "../primitives/Badge";

export type Status = "loading" | "idle";

export function ConnectButton({
  api,
  authMethodKey,
  organizationId,
  children,
  className,
}: {
  api: ExternalApi;
  authMethodKey: string;
  organizationId: string;
  children: React.ReactNode;
  className?: string;
}) {
  const transition = useTransition();
  const fetcher = useTypedFetcher<typeof action>();
  const apiAuthmethod = api.authenticationMethods[authMethodKey];
  const location = useLocation();

  return (
    <Sheet>
      <SheetTrigger className={className}>{children}</SheetTrigger>
      <SheetContent className="h-full">
        <fetcher.Form
          method="post"
          action="/resources/connection/oauth2"
          className="flex h-full flex-grow flex-col"
        >
          <SheetHeader>
            <SheetTitle>Select the scopes for {api.name}</SheetTitle>
            <SheetDescription>
              Select the scopes you want to grant to {api.name} to access your
              data. If you try and perform an action in a Job that requires a
              scope you haven't granted, that task will fail.
            </SheetDescription>
          </SheetHeader>

          <div
            className={classNames(
              "overflow-y-auto",
              transition.state !== "idle" && "opacity-50"
            )}
          >
            <div className="flex-grow overflow-y-auto">
              <input
                type="hidden"
                name="organizationId"
                value={organizationId}
              />
              <input type="hidden" name="api" value={api.identifier} />
              <input
                type="hidden"
                name="authenticationMethodKey"
                value={authMethodKey}
              />
              <input
                type="hidden"
                name="redirectTo"
                value={location.pathname}
              />

              <label htmlFor="title">Connection title</label>
              <Input
                type="text"
                name="title"
                id="title"
                defaultValue={api.name}
              />

              <Header3>Select scopes</Header3>
              <div className="flex flex-col gap-2">
                {apiAuthmethod.scopes.map((s) => {
                  const fieldName = `scopes[${s.name}]`;
                  return (
                    <fieldset key={s.name} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        name={fieldName}
                        id={fieldName}
                        defaultChecked={s.defaultChecked ?? false}
                        className="mt-1"
                      />
                      <div>
                        <div className="flex gap-2">
                          <label htmlFor={fieldName}>{s.name}</label>
                          {s.annotations &&
                            s.annotations.map((a) => (
                              <Badge
                                key={a.label}
                                className="py-0.5 px-1.5 text-xs"
                                style={{ backgroundColor: a.color }}
                              >
                                {a.label}
                              </Badge>
                            ))}
                        </div>
                        {s.description && (
                          <p className="text-slate-300">{s.description}</p>
                        )}
                      </div>
                    </fieldset>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="pt-4">
            {fetcher.data?.error ? (
              <p className="text-rose-500">{fetcher.data.error}</p>
            ) : null}
            <PrimaryButton
              type="submit"
              className="flex gap-2"
              disabled={transition.state !== "idle"}
            >
              <NamedIcon name={api.identifier} className="h-4 w-4" />{" "}
              <span>Connect to {api.name}</span>
            </PrimaryButton>
          </div>
        </fetcher.Form>
      </SheetContent>
    </Sheet>
  );
}

export function BasicConnectButton({
  api,
  authMethodKey,
  organizationId,
}: {
  api: ExternalApi;
  authMethodKey: string;
  organizationId: string;
}) {
  return (
    <ConnectButton
      api={api}
      authMethodKey={authMethodKey}
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

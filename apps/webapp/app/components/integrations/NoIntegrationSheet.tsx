import { useFetcher } from "@remix-run/react";
import React from "react";
import { type Api } from "~/services/externalApis/apis.server";
import { Header1 } from "../primitives/Headers";
import { NamedIconInBox } from "../primitives/NamedIcon";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from "../primitives/Sheet";
import { CustomHelp } from "./CustomHelp";

export function NoIntegrationSheet({
  api,
  requested,
  button,
}: {
  api: Api;
  requested: boolean;
  button: React.ReactNode;
}) {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== "idle";

  return (
    <Sheet>
      <SheetTrigger>{button}</SheetTrigger>
      <SheetContent size="lg">
        <SheetHeader className="justify-between">
          <div className="flex items-center gap-4">
            <NamedIconInBox name={api.identifier} className="h-9 w-9" />
            <Header1>{api.name}</Header1>
          </div>
        </SheetHeader>
        <SheetBody>
          <CustomHelp api={api} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

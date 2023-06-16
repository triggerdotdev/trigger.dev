import React from "react";
import { Api } from "~/services/externalApis/apis";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { Header1 } from "../primitives/Headers";
import { NamedIconInBox } from "../primitives/NamedIcon";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "../primitives/Sheet";
import { CustomHelp } from "./CustomHelp";
import { CheckIcon } from "@heroicons/react/24/solid";
import { useFetcher } from "@remix-run/react";
import { Paragraph } from "../primitives/Paragraph";

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
          {requested ? (
            <div className="flex items-center gap-1">
              <CheckIcon className="h-4 w-4 text-green-500" />
              <Paragraph variant="small">
                We'll let you know when the integration is available
              </Paragraph>
            </div>
          ) : (
            <fetcher.Form
              method="post"
              action={`/resources/apivote/${api.identifier}`}
            >
              <Button
                variant="primary/small"
                disabled={isLoading}
                LeadingIcon={isLoading ? "spinner-white" : undefined}
              >
                {isLoading
                  ? "Saving…"
                  : `I want an integration for ${api.name}`}
              </Button>
            </fetcher.Form>
          )}
        </SheetHeader>
        <SheetBody>
          <Callout variant="info">
            We don’t have an integration for the {api.name} API yet but you can
            request one by clicking the button above. In the meantime, connect
            to {api.name} using the methods below.
          </Callout>
          <CustomHelp name={api.name} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

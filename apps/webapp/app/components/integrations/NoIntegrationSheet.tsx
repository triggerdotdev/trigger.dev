import React, { useState } from "react";
import {
  ApiAuthenticationMethodApiKey,
  Integration,
} from "~/services/externalApis/types";
import { Header1, Header2 } from "../primitives/Headers";
import { NamedIconInBox } from "../primitives/NamedIcon";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "../primitives/Sheet";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";
import { ApiKeyHelp } from "./ApiKeyHelp";
import { CustomHelp } from "./CustomHelp";
import { SelectOAuthMethod } from "./SelectOAuthMethod";
import { Api } from "~/services/externalApis/apis";
import { Callout } from "../primitives/Callout";
import { Button } from "../primitives/Buttons";

export function NoIntegrationSheet({
  api,
  button,
}: {
  api: Api;
  button: React.ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger>{button}</SheetTrigger>
      <SheetContent size="lg">
        <SheetHeader className="justify-between">
          <div className="flex items-center gap-4">
            <NamedIconInBox name={api.identifier} className="h-9 w-9" />
            <Header1>{api.name}</Header1>
          </div>
          <Button variant="primary/small">
            I want an integration for {api.name}
          </Button>
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

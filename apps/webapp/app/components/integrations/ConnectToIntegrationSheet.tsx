import React, { useState } from "react";
import {
  ApiAuthenticationMethodApiKey,
  Integration,
} from "~/services/externalApis/types";
import { docsIntegrationPath } from "~/utils/pathBuilder";
import { LinkButton } from "../primitives/Buttons";
import { Header2 } from "../primitives/Headers";
import { NamedIconInBox } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "../primitives/Sheet";
import { ApiKeyHelp } from "./ApiKeyHelp";
import { CustomHelp } from "./CustomHelp";
import { SelectOAuthMethod } from "./SelectOAuthMethod";

type IntegrationMethod = "apikey" | "oauth2" | "custom";

export function ConnectToIntegrationSheet({
  integration,
  organizationId,
  button,
  className,
  callbackUrl,
}: {
  integration: Integration;
  organizationId: string;
  button: React.ReactNode;
  callbackUrl: string;
  className?: string;
}) {
  const [integrationMethod, setIntegrationMethod] = useState<
    IntegrationMethod | undefined
  >(undefined);

  const authMethods = Object.values(integration.authenticationMethods);
  const hasApiKeyOption = authMethods.some((s) => s.type === "apikey");
  const hasOAuth2Option = authMethods.some((s) => s.type === "oauth2");

  return (
    <Sheet>
      <SheetTrigger className={className}>{button}</SheetTrigger>
      <SheetContent size="lg" className="relative">
        <SheetHeader>
          <NamedIconInBox name={integration.identifier} className="h-9 w-9" />
          <div className="grow">
            <Header2>{integration.name}</Header2>
            {integration.description && (
              <Paragraph variant="small">{integration.description}</Paragraph>
            )}
          </div>
          <LinkButton
            to={docsIntegrationPath(integration.identifier)}
            variant="secondary/small"
            LeadingIcon="docs"
          >
            View docs
          </LinkButton>
        </SheetHeader>
        <SheetBody>
          <Header2 className="mb-2">Choose an integration method</Header2>
          <RadioGroup
            name="method"
            className="flex gap-2"
            value={integrationMethod}
            onValueChange={(v) => setIntegrationMethod(v as IntegrationMethod)}
          >
            {hasOAuth2Option && (
              <RadioGroupItem
                id="oauth2"
                value="oauth2"
                label="OAuth"
                description="We handle OAuth for you or your users."
                variant="description"
              />
            )}
            {hasApiKeyOption && (
              <RadioGroupItem
                id="apikey"
                value="apikey"
                label="API Key"
                description="Use API keys in your code. They never leave your server."
                variant="description"
              />
            )}
            <RadioGroupItem
              id="custom"
              value="custom"
              label="Fetch/Existing SDK"
              description={`Alternatively, use ${integration.name} without our integration.`}
              variant="description"
            />
          </RadioGroup>

          {integrationMethod && (
            <SelectedIntegrationMethod
              integration={integration}
              organizationId={organizationId}
              method={integrationMethod}
              callbackUrl={callbackUrl}
            />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function SelectedIntegrationMethod({
  integration,
  organizationId,
  method,
  callbackUrl,
}: {
  integration: Integration;
  organizationId: string;
  method: IntegrationMethod;
  callbackUrl: string;
}) {
  const authMethods = Object.values(integration.authenticationMethods);

  switch (method) {
    case "apikey":
      const apiAuth = authMethods.find((a) => a.type === "apikey");
      if (!apiAuth) return null;
      return (
        <ApiKeyHelp
          integration={integration}
          apiAuth={apiAuth as ApiAuthenticationMethodApiKey}
        />
      );
    case "oauth2":
      return (
        <SelectOAuthMethod
          integration={integration}
          organizationId={organizationId}
          callbackUrl={callbackUrl}
        />
      );
    case "custom":
      return <CustomHelp name={integration.name} />;
  }
}

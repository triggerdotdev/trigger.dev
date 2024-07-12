import { useState } from "react";
import {
  type ApiAuthenticationMethodOAuth2,
  type Integration,
} from "~/services/externalApis/types";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";
import type { ConnectionType } from "@trigger.dev/database";
import { Header2 } from "../primitives/Headers";
import { ConnectToOAuthForm } from "./ConnectToOAuthForm";
import { Paragraph } from "../primitives/Paragraph";
import { type Client } from "~/presenters/IntegrationsPresenter.server";
import { UpdateOAuthForm } from "./UpdateOAuthForm";
import { LinkButton } from "../primitives/Buttons";
import { BookOpenIcon } from "@heroicons/react/20/solid";

export function SelectOAuthMethod({
  integration,
  organizationId,
  callbackUrl,
  existingIntegration,
}: {
  existingIntegration?: Client;
  integration: Integration;
  organizationId: string;
  callbackUrl: string;
}) {
  const oAuthMethods = Object.entries(integration.authenticationMethods).filter(
    (a): a is [string, ApiAuthenticationMethodOAuth2] => a[1].type === "oauth2"
  );

  const [oAuthKey, setOAuthKey] = useState<string | undefined>(
    oAuthMethods.length === 1 ? oAuthMethods[0][0] : undefined
  );
  const [connectionType, setConnectionType] = useState<ConnectionType | undefined>();

  const selectedOAuthMethod = oAuthKey
    ? (integration.authenticationMethods[oAuthKey] as ApiAuthenticationMethodOAuth2)
    : undefined;

  return (
    <>
      {oAuthMethods.length > 1 && (
        <>
          <Header2 className="mb-2 mt-4">Select an OAuth option</Header2>
          <RadioGroup
            name="oauth-method"
            className="flex gap-2"
            value={oAuthKey}
            onValueChange={(v: any) => setOAuthKey(v)}
          >
            {oAuthMethods.map(([key, auth]) => (
              <RadioGroupItem
                key={key}
                id={key}
                value={key}
                label={auth.name}
                description={auth.description}
                variant="description"
              />
            ))}
          </RadioGroup>
        </>
      )}
      {selectedOAuthMethod && (
        <>
          <Header2 className="mb-2 mt-4">Who is connecting to {integration.name}</Header2>
          <RadioGroup
            name="connection-type"
            className="flex gap-2"
            value={connectionType}
            onValueChange={(v: any) => setConnectionType(v as ConnectionType)}
          >
            <RadioGroupItem
              id="DEVELOPER"
              value="DEVELOPER"
              label="Developers"
              description={`You will connect using an internal ${integration.name} account.`}
              variant="description"
            />
            <RadioGroupItem
              id="EXTERNAL"
              value="EXTERNAL"
              label="Your users"
              description="Use an external authentication provider or your own user database to provide auth credentails of your users."
              variant="description"
            />
          </RadioGroup>
        </>
      )}
      {selectedOAuthMethod &&
        connectionType &&
        oAuthKey &&
        (connectionType === "DEVELOPER" ? (
          existingIntegration ? (
            <UpdateOAuthForm
              existingIntegration={existingIntegration}
              integration={integration}
              authMethod={selectedOAuthMethod}
              authMethodKey={oAuthKey}
              organizationId={organizationId}
              clientType={connectionType}
              callbackUrl={callbackUrl}
            />
          ) : (
            <ConnectToOAuthForm
              integration={integration}
              authMethod={selectedOAuthMethod}
              authMethodKey={oAuthKey}
              organizationId={organizationId}
              clientType={connectionType}
              callbackUrl={callbackUrl}
            />
          )
        ) : (
          <>
            <Header2 className="mb-1 mt-4">BYO Auth</Header2>
            <Paragraph spacing>
              We support external authentication providers through Auth Resolvers. Read the docs to
              learn more:{" "}
              <LinkButton
                variant={"tertiary/small"}
                LeadingIcon={BookOpenIcon}
                TrailingIcon={"external-link"}
                to="https://trigger.dev/docs/documentation/guides/using-integrations-byo-auth"
                target="_blank"
              >
                Bring your own Auth
              </LinkButton>
            </Paragraph>
          </>
        ))}
    </>
  );
}

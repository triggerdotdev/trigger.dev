import { useState } from "react";
import {
  ApiAuthenticationMethodOAuth2,
  Integration,
} from "~/services/externalApis/types";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";

export function SelectOAuthMethod({
  integration,
}: {
  integration: Integration;
}) {
  const [oAuthKey, setOAuthKey] = useState<string | undefined>(undefined);
  const oAuthMethods = Object.entries(integration.authenticationMethods).filter(
    (a): a is [string, ApiAuthenticationMethodOAuth2] => a[1].type === "oauth2"
  );
  const selectedOAuthMethod = oAuthKey
    ? (integration.authenticationMethods[
        oAuthKey
      ] as ApiAuthenticationMethodOAuth2)
    : undefined;

  return (
    <RadioGroup
      name="oauth-method"
      className="flex gap-2"
      value={oAuthKey}
      onValueChange={(v) => setOAuthKey(v)}
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
  );
}

import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useFetcher, useLocation, useNavigation } from "@remix-run/react";
import cuid from "cuid";
import React, { useState } from "react";
import simplur from "simplur";
import { useTextFilter } from "~/hooks/useTextFilter";
import { ApiConnectionType } from "~/models/apiConnection.server";
import { createSchema } from "~/routes/resources.connection.$organizationId.oauth2";
import {
  ApiAuthenticationMethodOAuth2,
  Integration,
  Scope,
} from "~/services/externalApis/types";
import { cn } from "~/utils/cn";
import { CodeBlock } from "../code/CodeBlock";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { Checkbox } from "../primitives/Checkbox";
import { Fieldset } from "../primitives/Fieldset";
import { FormError } from "../primitives/FormError";
import { Header2, Header3 } from "../primitives/Headers";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { NamedIcon, NamedIconInBox } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";

export type Status = "loading" | "idle";

export function ConnectToOAuthForm({
  integration,
  authMethod,
  authMethodKey,
  organizationId,
  clientType,
}: {
  integration: Integration;
  authMethod: ApiAuthenticationMethodOAuth2;
  authMethodKey: string;
  organizationId: string;
  clientType: ApiConnectionType;
}) {
  const [id] = useState<string>(cuid());
  const transition = useNavigation();
  const fetcher = useFetcher();
  const [
    form,
    { title, scopes, hasCustomClient, customClientId, customClientSecret },
  ] = useForm({
    lastSubmission: fetcher.data,
    onValidate({ formData }) {
      return parse(formData, {
        // Create the schema without any constraint defined
        schema: createSchema(),
      });
    },
  });

  const location = useLocation();

  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(
    new Set(
      authMethod.scopes.filter((s) => s.defaultChecked).map((s) => s.name)
    )
  );

  const [useMyOAuthApp, setUseMyOAuthApp] = useState(clientType === "EXTERNAL");

  const { filterText, setFilterText, filteredItems } = useTextFilter<Scope>({
    items: authMethod.scopes,
    filter: (scope, text) => {
      if (scope.name.toLowerCase().includes(text.toLowerCase())) return true;
      if (
        scope.description &&
        scope.description.toLowerCase().includes(text.toLowerCase())
      )
        return true;

      return false;
    },
  });

  return (
    <fetcher.Form
      method="post"
      action={`/resources/connection/${organizationId}/oauth2`}
      {...form.props}
      className="flex h-full max-h-full flex-grow flex-col"
    >
      <Fieldset>
        <input type="hidden" name="id" value={id} />
        <input
          type="hidden"
          name="integrationIdentifier"
          value={integration.identifier}
        />
        <input
          type="hidden"
          name="integrationAuthMethod"
          value={authMethodKey}
        />
        <input type="hidden" name="redirectTo" value={location.pathname} />
        <InputGroup>
          <FormError>{form.error}</FormError>
        </InputGroup>
        <InputGroup fullWidth>
          <Label variant="large">Name</Label>
          <Input
            type="text"
            fullWidth
            {...conform.input(title)}
            placeholder={`e.g. Personal ${integration.name}`}
          />
          <FormError>{title.error}</FormError>
        </InputGroup>
        <Callout variant="info">
          Coming soon – create connections so you can run Jobs with your users
          credentials.
        </Callout>
        <input type="hidden" name="clientType" value={clientType} />
        <div>
          <Header2>Use my OAuth App</Header2>
          <Paragraph variant="small" className="mb-2">
            To use your own OAuth app, check the option below and insert the
            details.
          </Paragraph>
          <Checkbox
            id="hasCustomClient"
            label="Use my OAuth App"
            variant="simple/small"
            defaultChecked={clientType === "EXTERNAL" ? true : useMyOAuthApp}
            disabled={clientType === "EXTERNAL"}
            onChange={(checked) => setUseMyOAuthApp(checked)}
            {...conform.input(hasCustomClient, { type: "checkbox" })}
          />
          {useMyOAuthApp && (
            <div className="ml-6 mt-2">
              <Paragraph variant="small" className="mb-2">
                Set the callback url to{" "}
                <CodeBlock
                  code={`${origin}/oauth2/callback`}
                  showLineNumbers={false}
                />
              </Paragraph>
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <InputGroup fullWidth>
                    <Label variant="small">Client ID</Label>
                    <Input
                      fullWidth
                      {...conform.input(customClientId, { type: "text" })}
                    />
                  </InputGroup>
                  <InputGroup fullWidth>
                    <Label variant="small">Client secret</Label>
                    <Input
                      fullWidth
                      {...conform.input(customClientSecret, {
                        type: "password",
                      })}
                    />
                  </InputGroup>
                </div>
                <FormError>{customClientId.error}</FormError>
              </div>
            </div>
          )}
        </div>
        <div>
          <Header2>Scopes</Header2>
          <Paragraph variant="small" className="mb-4">
            Select the scopes you want to grant to {integration.name} in order
            for it to access your data. Note: If you try and perform an action
            in a Job that requires a scope you haven’t granted, that task will
            fail.
          </Paragraph>
          {/* <Header3 className="mb-2">
                  Select from popular scope collections
                </Header3>
                <fieldset>
                  <Checkbox
                    id="allScopes"
                    label="Select all"
                    variant="button/small"
                  />
                </fieldset> */}
          <div className="mb-2 mt-4 flex items-center justify-between">
            <Header3>Select {integration.name} scopes</Header3>
            <Paragraph variant="small" className="text-slate-500">
              {simplur`${selectedScopes.size} scope[|s] selected`}
            </Paragraph>
          </div>
          <Input
            placeholder="Search scopes"
            className="mb-2"
            variant="medium"
            icon="search"
            fullWidth={true}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          <div className="flex flex-col gap-y-0.5 overflow-hidden rounded-md">
            {filteredItems.length === 0 && (
              <Paragraph variant="small" className="p-4">
                No scopes match {filterText}. Try a different search query.
              </Paragraph>
            )}
            {authMethod.scopes.map((s) => {
              return (
                <Checkbox
                  key={s.name}
                  id={s.name}
                  value={s.name}
                  name="scopes"
                  label={s.name}
                  defaultChecked={s.defaultChecked ?? false}
                  badges={s.annotations?.map((a) => a.label)}
                  description={s.description}
                  variant="description"
                  className={cn(
                    filteredItems.find((f) => f.name === s.name) ? "" : "hidden"
                  )}
                  onChange={(isChecked) => {
                    if (isChecked) {
                      setSelectedScopes((selected) => {
                        selected.add(s.name);
                        return new Set(selected);
                      });
                    } else {
                      setSelectedScopes((selected) => {
                        selected.delete(s.name);
                        return new Set(selected);
                      });
                    }
                  }}
                />
              );
            })}
          </div>
        </div>
      </Fieldset>

      <div className="flex items-center justify-end gap-x-4">
        <FormError>{scopes.error}</FormError>
        <Button
          type="submit"
          className="flex gap-2"
          disabled={transition.state !== "idle"}
          variant="primary/medium"
        >
          <>
            <NamedIcon name={integration.identifier} className={"h-4 w-4"} />
            Connect to {integration.name}
          </>
        </Button>
      </div>
    </fetcher.Form>
  );
}

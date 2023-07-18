import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useFetcher, useLocation, useNavigation } from "@remix-run/react";
import type { ConnectionType } from "@trigger.dev/database";
import { useState } from "react";
import simplur from "simplur";
import { useFeatures } from "~/hooks/useFeatures";
import { useTextFilter } from "~/hooks/useTextFilter";
import {
  ApiAuthenticationMethodOAuth2,
  Integration,
  Scope,
} from "~/services/externalApis/types";
import { cn } from "~/utils/cn";
import { CodeBlock } from "../code/CodeBlock";
import { Button } from "../primitives/Buttons";
import { Checkbox } from "../primitives/Checkbox";
import { Fieldset } from "../primitives/Fieldset";
import { FormError } from "../primitives/FormError";
import { Header2, Header3 } from "../primitives/Headers";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { Paragraph } from "../primitives/Paragraph";
import { Client } from "~/presenters/IntegrationsPresenter.server";
import { schema } from "~/routes/resources.connection.$organizationId.oauth2.$integrationId";

export type Status = "loading" | "idle";

export function UpdateOAuthForm({
  existingIntegration,
  integration,
  authMethod,
  authMethodKey,
  organizationId,
  clientType,
  callbackUrl,
}: {
  existingIntegration: Client;
  integration: Integration;
  authMethod: ApiAuthenticationMethodOAuth2;
  authMethodKey: string;
  organizationId: string;
  clientType: ConnectionType;
  callbackUrl: string;
}) {
  const transition = useNavigation();
  const fetcher = useFetcher();
  const { isManagedCloud } = useFeatures();

  const [
    form,
    { title, scopes, hasCustomClient, customClientId, customClientSecret },
  ] = useForm({
    lastSubmission: fetcher.data,
    onValidate({ formData }) {
      return parse(formData, {
        schema,
      });
    },
  });

  const location = useLocation();

  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(
    new Set(
      authMethod.scopes.filter((s) => s.defaultChecked).map((s) => s.name)
    )
  );

  const requiresCustomOAuthApp = clientType === "EXTERNAL" || !isManagedCloud;

  const [useMyOAuthApp, setUseMyOAuthApp] = useState(requiresCustomOAuthApp);

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
      method="put"
      action={`/resources/connection/${organizationId}/oauth2/${existingIntegration.id}`}
      {...form.props}
      className="flex h-full max-h-full flex-grow flex-col"
    >
      <Fieldset>
        <input type="hidden" name="id" value={existingIntegration.id} />
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
          <Label variant="large">ID</Label>
          <Paragraph variant="small" className="mb-2">
            {existingIntegration.slug}
          </Paragraph>
        </InputGroup>
        <InputGroup fullWidth>
          <Label variant="large">Name</Label>
          <Input
            type="text"
            fullWidth
            {...conform.input(title)}
            defaultValue={existingIntegration.title ?? undefined}
            placeholder={`e.g. Personal ${integration.name}`}
          />
          <FormError>{title.error}</FormError>
        </InputGroup>
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
            disabled={requiresCustomOAuthApp}
            onChange={(checked) => setUseMyOAuthApp(checked)}
            {...conform.input(hasCustomClient, { type: "checkbox" })}
            defaultChecked={requiresCustomOAuthApp}
          />
          {useMyOAuthApp && (
            <div className="ml-6 mt-2">
              <Paragraph variant="small" className="mb-2">
                Set the callback url to{" "}
                <CodeBlock code={callbackUrl} showLineNumbers={false} />
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
        {authMethod.scopes.length > 0 && (
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
            <div className="mb-28 flex flex-col gap-y-0.5 overflow-hidden rounded-md">
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
                      filteredItems.find((f) => f.name === s.name)
                        ? ""
                        : "hidden"
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
        )}
      </Fieldset>

      <div className="absolute bottom-0 left-0 flex w-full items-center justify-end gap-x-4 rounded-b-md border-t border-slate-800 bg-midnight-900 p-4">
        <FormError>{scopes.error}</FormError>
        <Button
          type="submit"
          className="flex gap-2"
          disabled={transition.state !== "idle"}
          variant="primary/medium"
          LeadingIcon={integration.identifier}
        >
          Connect to {integration.name}
        </Button>
      </div>
    </fetcher.Form>
  );
}

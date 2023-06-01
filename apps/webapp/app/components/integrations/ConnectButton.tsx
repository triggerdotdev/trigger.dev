import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useFetcher, useLocation, useNavigation } from "@remix-run/react";
import React, { useState } from "react";
import simplur from "simplur";
import { createSchema } from "~/routes/resources.connection.$organizationId.oauth2";
import { Integration } from "~/services/externalApis/types";
import { InlineCode } from "../code/InlineCode";
import { Button } from "../primitives/Buttons";
import { Checkbox } from "../primitives/Checkbox";
import { Fieldset } from "../primitives/Fieldset";
import { FormError } from "../primitives/FormError";
import FormSegmentedControl from "../primitives/FormSegmentedControl";
import { Header2, Header3 } from "../primitives/Headers";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { NamedIcon, NamedIconInBox } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "../primitives/Sheet";

export type Status = "loading" | "idle";

export function ConnectButton({
  integration: api,
  authMethodKey,
  organizationId,
  children,
  className,
}: {
  integration: Integration;
  authMethodKey: string;
  organizationId: string;
  children: React.ReactNode;
  className?: string;
}) {
  const transition = useNavigation();
  const fetcher = useFetcher();
  const [form, { title, scopes }] = useForm({
    lastSubmission: fetcher.data,
    onValidate({ formData }) {
      return parse(formData, {
        // Create the schema without any constraint defined
        schema: createSchema(),
      });
    },
  });
  const apiAuthmethod = api.authenticationMethods[authMethodKey];
  const location = useLocation();

  const options = [
    { label: "Your team", value: "DEVELOPER" },
    { label: "Your users", value: "EXTERNAL" },
  ];

  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(
    new Set(
      apiAuthmethod.scopes.filter((s) => s.defaultChecked).map((s) => s.name)
    )
  );

  const [useMyOAuthApp, setUseMyOAuthApp] = useState(false);

  const [connectionType, setConnectionType] = useState<
    "EXTERNAL" | "DEVELOPER"
  >("DEVELOPER");

  return (
    <Sheet>
      <SheetTrigger className={className}>{children}</SheetTrigger>
      <SheetContent size="lg">
        <fetcher.Form
          method="post"
          action={`/resources/connection/${organizationId}/oauth2`}
          {...form.props}
          className="flex h-full max-h-full flex-grow flex-col"
        >
          <SheetBody>
            <div className="flex items-center gap-4 border-b border-slate-800 pb-3.5">
              <NamedIconInBox name={api.identifier} className="h-9 w-9" />
              <div>
                <Header2>Connect to {api.name}</Header2>
                <Paragraph variant="extra-small">
                  {apiAuthmethod.name}{" "}
                  {apiAuthmethod.description &&
                    `– ${apiAuthmethod.description}`}
                </Paragraph>
              </div>
            </div>

            <Fieldset>
              <input
                type="hidden"
                name="integrationIdentifier"
                value={api.identifier}
              />
              <input
                type="hidden"
                name="integrationAuthMethod"
                value={authMethodKey}
              />
              <input
                type="hidden"
                name="redirectTo"
                value={location.pathname}
              />
              <InputGroup>
                <FormError>{form.error}</FormError>
              </InputGroup>
              <InputGroup fullWidth>
                <Label variant="large">Name</Label>
                <Input
                  type="text"
                  fullWidth
                  {...conform.input(title)}
                  placeholder={`e.g. Personal ${api.name}`}
                />
                <FormError>{title.error}</FormError>
              </InputGroup>
              <div>
                <Header2>Who will connect to this API?</Header2>
                <Paragraph variant="small" className="mb-2">
                  Select ‘Your team’ if you want create internal Jobs for your
                  own company. Select 'Your users' if you want to create Jobs
                  where your customers authenticate with this API.
                </Paragraph>
                <FormSegmentedControl
                  name="connectionType"
                  defaultValue={connectionType}
                  options={options}
                  onChange={(val) => setConnectionType(val as any)}
                />
              </div>
              <div>
                <Header2>Use my OAuth App</Header2>
                <Paragraph variant="small" className="mb-2">
                  If you'd like to use your own OAuth app, you can insert the
                  details below. You will need to set the callback url to{" "}
                  <InlineCode variant="extra-small">
                    https://app.trigger.dev/oauth/slack-2/callback
                  </InlineCode>
                </Paragraph>
                <Checkbox
                  id="oauth"
                  name="oauth"
                  label="Use my OAuth App"
                  variant="simple/small"
                  defaultChecked={
                    connectionType === "EXTERNAL" ? true : useMyOAuthApp
                  }
                  disabled={connectionType === "EXTERNAL"}
                  onChange={(checked) => setUseMyOAuthApp(checked)}
                />
                {useMyOAuthApp && (
                  <div className="ml-6 mt-2 flex gap-2">
                    <InputGroup fullWidth>
                      <Label variant="small">Client ID</Label>
                      <Input type="text" fullWidth {...conform.input(title)} />
                      <FormError>{title.error}</FormError>
                    </InputGroup>
                    <InputGroup fullWidth>
                      <Label variant="small">Client secret</Label>
                      <Input type="text" fullWidth {...conform.input(title)} />
                      <FormError>{title.error}</FormError>
                    </InputGroup>
                  </div>
                )}
              </div>
              <div>
                <Header2>Scopes</Header2>
                <Paragraph variant="small" className="mb-2">
                  Select the scopes you want to grant to {api.name} in order for
                  it to access your data. Note: If you try and perform an action
                  in a Job that requires a scope you haven’t granted, that task
                  will fail.
                </Paragraph>
                <Header3 className="mb-2">
                  Select from popular scope collections
                </Header3>
                <fieldset>
                  <Checkbox
                    id="allScopes"
                    label="Select all"
                    variant="button/small"
                  />
                </fieldset>
                <div className="flex items-center justify-between">
                  <Header3 className="mt-4">Select scopes</Header3>
                  <Paragraph variant="small" className="text-slate-500">
                    {simplur`${selectedScopes.size} scope[|s] selected`}
                  </Paragraph>
                </div>
                <div className="flex flex-col gap-y-0.5 overflow-hidden rounded-md">
                  {apiAuthmethod.scopes.map((s) => {
                    return (
                      <fieldset key={s.name} className="flex items-start gap-2">
                        <Checkbox
                          id={s.name}
                          value={s.name}
                          name="scopes"
                          label={s.name}
                          defaultChecked={s.defaultChecked ?? false}
                          badges={s.annotations?.map((a) => a.label)}
                          description={s.description}
                          variant="description"
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
                      </fieldset>
                    );
                  })}
                </div>
              </div>
            </Fieldset>
          </SheetBody>
          <SheetFooter>
            <div className="flex items-center justify-end gap-x-4">
              <FormError>{scopes.error}</FormError>
              <Button
                type="submit"
                className="flex gap-2"
                disabled={transition.state !== "idle"}
                variant="primary/medium"
              >
                <>
                  <NamedIcon name={api.identifier} className={"h-4 w-4"} />
                  Connect to {api.name}
                </>
              </Button>
            </div>
          </SheetFooter>
        </fetcher.Form>
      </SheetContent>
    </Sheet>
  );
}

export function BasicConnectButton({
  integration,
  authMethodKey,
  organizationId,
}: {
  integration: Integration;
  authMethodKey: string;
  organizationId: string;
}) {
  return (
    <ConnectButton
      integration={integration}
      authMethodKey={authMethodKey}
      organizationId={organizationId}
      className="flex items-center gap-3 rounded bg-indigo-700 py-2 pl-3 pr-4 text-sm text-white shadow-md transition hover:bg-indigo-600 disabled:opacity-50"
    >
      <>
        <NamedIcon name={integration.identifier} className={"h-8 w-8"} />
        <span>Connect to {integration.name}</span>
      </>
    </ConnectButton>
  );
}

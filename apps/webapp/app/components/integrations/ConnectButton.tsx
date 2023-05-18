import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useFetcher, useLocation, useNavigation } from "@remix-run/react";
import { Integration } from "~/services/externalApis/types";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Buttons";
import { Fieldset } from "../primitives/Fieldset";
import { Header2, Header3 } from "../primitives/Headers";
import { Hint } from "../primitives/Hint";
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
import { createSchema } from "~/routes/resources.connection.$organizationId.oauth2";
import { FormError } from "../primitives/FormError";

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

  return (
    <Sheet>
      <SheetTrigger className={className}>{children}</SheetTrigger>
      <SheetContent className="h-full" size="lg">
        <fetcher.Form
          method="post"
          action={`/resources/connection/${organizationId}/oauth2`}
          {...form.props}
          className="flex h-full max-h-full flex-grow flex-col"
        >
          <SheetBody>
            <div className="flex gap-4 border-b border-slate-800 pb-4">
              <NamedIconInBox name={api.identifier} className="h-9 w-9" />
              <div>
                <Header2 className="m-0">Connect to {api.name}</Header2>
                <Paragraph className="m-0">
                  {apiAuthmethod.name}{" "}
                  {apiAuthmethod.description &&
                    `– ${apiAuthmethod.description}`}
                </Paragraph>
              </div>
            </div>

            <Fieldset className="mt-4">
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
              <InputGroup>
                <Label>Name</Label>
                <Input
                  type="text"
                  {...conform.input(title)}
                  placeholder={`e.g. Personal ${api.name}`}
                />
                <Hint>This will appear in the list</Hint>
                <FormError>{title.error}</FormError>
              </InputGroup>
              <Header3>Select scopes</Header3>

              <div className="flex flex-col gap-2">
                {apiAuthmethod.scopes.map((s) => {
                  return (
                    <fieldset key={s.name} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        name="scopes"
                        value={s.name}
                        id={s.name}
                        defaultChecked={s.defaultChecked ?? false}
                        className="mt-1"
                      />
                      <div>
                        <div className="flex gap-2">
                          <label htmlFor={s.name}>{s.name}</label>
                          {s.annotations &&
                            s.annotations.map((a) => (
                              <Badge
                                key={a.label}
                                className="px-1.5 py-0.5 text-xs"
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
            </Fieldset>
          </SheetBody>
          <SheetFooter>
            <div className="pt-4">
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

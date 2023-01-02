import { useFetcher } from "@remix-run/react";
import type {
  APIKeyAuthentication,
  CatalogIntegration,
} from "internal-catalog";
import { marked } from "marked";
import { Fragment, useState } from "react";
import { PrimaryButton, SecondaryButton } from "../primitives/Buttons";
import { StyledDialog } from "../primitives/Dialog";
import { FormError } from "../primitives/FormError";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { Response as CreateResponse } from "~/routes/resources/connection";
import { useTypedFetcher } from "remix-typedjson";

type Status = "loading" | "idle";

export function AddApiKeyButton({
  integration,
  authentication,
  organizationId,
  sourceId,
  serviceId,
  className,
  children,
}: {
  integration: CatalogIntegration;
  authentication: APIKeyAuthentication;
  organizationId: string;
  sourceId?: string;
  serviceId?: string;
  className?: string;
  children: (status: Status) => React.ReactNode;
}) {
  const fetcher = useTypedFetcher<CreateResponse>();
  const [isOpen, setIsOpen] = useState(false);

  const errors =
    fetcher.type === "done" && !fetcher.data.success
      ? fetcher.data.errors
      : undefined;

  return (
    <>
      <button onClick={(e) => setIsOpen(true)} className={className}>
        {children(fetcher.state === "idle" ? "idle" : "loading")}
      </button>

      <StyledDialog.Dialog
        onClose={(e) => setIsOpen(false)}
        appear
        show={isOpen}
        as={Fragment}
      >
        <StyledDialog.Panel>
          <StyledDialog.Title>
            Add {integration.name} API keys
          </StyledDialog.Title>
          <div className="mt-2">
            <p
              className="prose prose-sm prose-invert"
              dangerouslySetInnerHTML={{
                __html: marked(authentication.documentation),
              }}
            />
          </div>

          <fetcher.Form method="post" action="/resources/connection?index">
            <input type="hidden" name="type" value="api_key" />
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="service" value={integration.slug} />
            {sourceId && (
              <input type="hidden" name="sourceId" value={sourceId} />
            )}
            {serviceId && (
              <input type="hidden" name="serviceId" value={serviceId} />
            )}
            <InputGroup>
              <Label htmlFor="title">Name</Label>
              <Input
                id="title"
                name="title"
                placeholder="The name of this connection"
                defaultValue={integration.name}
              />
              {errors && <FormError errors={errors} path={["title"]} />}
            </InputGroup>

            <InputGroup>
              <Label htmlFor="api_key">API Key</Label>
              <Input id="api_key" name="api_key" placeholder="<api_key>" />
              {errors && <FormError errors={errors} path={["api_key"]} />}
            </InputGroup>

            <div className="mt-4 flex justify-between">
              <PrimaryButton type="submit">Save</PrimaryButton>
              <SecondaryButton type="button" onClick={(e) => setIsOpen(false)}>
                Cancel
              </SecondaryButton>
            </div>
          </fetcher.Form>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
    </>
  );
}

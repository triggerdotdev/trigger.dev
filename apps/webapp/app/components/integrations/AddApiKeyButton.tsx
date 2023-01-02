import type {
  APIKeyAuthentication,
  CatalogIntegration,
} from "internal-catalog";
import { Fragment, useState } from "react";
import { marked } from "marked";
import { StyledDialog } from "../primitives/Dialog";
import { PrimaryButton, SecondaryButton } from "../primitives/Buttons";
import { Form, useFetcher } from "@remix-run/react";
import { Input } from "../primitives/Input";
import { Label } from "../primitives/Label";
import { InputGroup } from "../primitives/InputGroup";

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
  // const fetcher = useFetcher<CreateResponse>();

  const [status, setStatus] = useState<Status>("idle");
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button onClick={(e) => setIsOpen(true)} className={className}>
        {children(status)}
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

          <Form>
            <InputGroup>
              <Label htmlFor="title">Name</Label>
              <Input
                id="title"
                name="title"
                placeholder="The name of this connection"
              />
            </InputGroup>

            <InputGroup>
              <Label htmlFor="apiKey">API Key</Label>
              <Input id="apiKey" name="apiKey" placeholder="<api_key>" />
            </InputGroup>

            <div className="mt-4 flex justify-between">
              <PrimaryButton type="submit">Save</PrimaryButton>
              <SecondaryButton type="button" onClick={(e) => setIsOpen(false)}>
                Cancel
              </SecondaryButton>
            </div>
          </Form>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
    </>
  );
}

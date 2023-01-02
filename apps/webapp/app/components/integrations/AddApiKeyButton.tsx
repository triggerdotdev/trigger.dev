import { Dialog } from "@headlessui/react";
import type {
  APIKeyAuthentication,
  CatalogIntegration,
} from "internal-catalog";
import { Fragment, useState } from "react";
import { marked } from "marked";
import { StyledDialog } from "../primitives/Dialog";
import { PrimaryButton } from "../primitives/Buttons";

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

          <div className="mt-4 flex justify-between">
            <PrimaryButton type="button" onClick={(e) => setIsOpen(false)}>
              Close
            </PrimaryButton>
          </div>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
    </>
  );
}

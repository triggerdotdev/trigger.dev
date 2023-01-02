import { Dialog } from "@headlessui/react";
import type {
  APIKeyAuthentication,
  CatalogIntegration,
} from "internal-catalog";
import { Fragment, useState } from "react";
import { marked } from "marked";
import { StyledDialog } from "../primitives/Dialog";

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
        <StyledDialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
          <StyledDialog.Title>
            Add {integration.name} API keys
          </StyledDialog.Title>
          <div className="mt-2">
            <p
              className="prose prose-sm prose-slate"
              dangerouslySetInnerHTML={{
                __html: marked(authentication.documentation),
              }}
            />
          </div>

          <div className="mt-4 flex justify-between">
            <button
              type="button"
              className="inline-flex justify-center rounded-md border border-transparent bg-blue-100 px-4 py-2 text-sm font-medium text-blue-900 hover:bg-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              onClick={(e) => setIsOpen(false)}
            >
              Close
            </button>
          </div>
        </StyledDialog.Panel>
      </StyledDialog.Dialog>
    </>
  );
}

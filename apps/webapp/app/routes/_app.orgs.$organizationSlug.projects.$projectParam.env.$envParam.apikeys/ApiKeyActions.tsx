import { NoSymbolIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form } from "@remix-run/react";
import { useState } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION,
  type StoredApiKeyAccess,
} from "~/utils/apiKeyAccess";
import { type ApiKeyUsageView } from "~/utils/apiKeyUsage";
import { type EditableApiKey } from "./EditApiKeyAccessDialog";

export const ROOT_API_KEY_PARAM = "root";

type ApiKeyRow = {
  id: string;
  name: string;
  createdBy: { displayName: string | null; name: string | null; email: string } | null;
  access: StoredApiKeyAccess & { unmatchedScopes?: string[] };
};

export function apiKeyCreator(apiKey: Pick<ApiKeyRow, "createdBy">, unknown = "–"): string {
  return (
    apiKey.createdBy?.displayName ?? apiKey.createdBy?.name ?? apiKey.createdBy?.email ?? unknown
  );
}

export function editableApiKey(apiKey: ApiKeyRow, usage?: ApiKeyUsageView | null): EditableApiKey {
  return {
    id: apiKey.id,
    name: apiKey.name,
    presetId: apiKey.access.presetId,
    fullAccess: apiKey.access.fullAccess,
    capabilities: apiKey.access.capabilities,
    taskIdentifiers: apiKey.access.taskIdentifiers,
    unmatchedScopes: apiKey.access.unmatchedScopes,
    matchesPreset: apiKey.access.matchesPreset,
    usage,
  };
}

/** Without an `appearance`, renders as a small secondary button (the migration steps). */
export function DisableRootApiKeyButton({
  canWrite,
  appearance,
}: {
  canWrite: boolean;
  appearance?: ActionAppearance;
}) {
  const [confirmation, setConfirmation] = useState("");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          {...(appearance
            ? actionButtonProps(appearance)
            : { variant: "secondary/small" as const })}
          LeadingIcon={NoSymbolIcon}
          leadingIconClassName={appearance ? "text-error" : undefined}
          disabled={!canWrite}
          tooltip={
            canWrite ? undefined : "You don't have permission to disable root API key visibility"
          }
        >
          Stop using the root key…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>Stop using the root API key</DialogHeader>
        <Form method="post" className="flex flex-col gap-4 pt-3">
          <input type="hidden" name="action" value="disable-root" />
          <Callout variant="warning">
            The current root key will stop working in 24 hours. Anything still using it will fail to
            authenticate after that.
          </Callout>
          <div className="space-y-2">
            <Paragraph variant="small">
              Before continuing, set <InlineCode variant="small">TRIGGER_SECRET_KEY</InlineCode> to
              an API key in every app that triggers your tasks. Existing API keys are not affected.
            </Paragraph>
            <Paragraph variant="small">
              This generates a new hidden root key and permanently disables full root key
              visibility. This can't be reversed.
            </Paragraph>
          </div>
          <InputGroup className="max-w-full">
            <Paragraph variant="small/bright">
              Enter{" "}
              <InlineCode variant="small">
                {DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION}
              </InlineCode>{" "}
              to confirm:
            </Paragraph>
            <Input
              name="confirmation"
              type="text"
              placeholder={DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION}
              autoComplete="off"
              fullWidth
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </InputGroup>
          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant="danger/medium"
                disabled={confirmation !== DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION}
              >
                Hide root key and start 24-hour expiry
              </Button>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium">Cancel</Button>
              </DialogClose>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export type ActionAppearance = "menu" | "button";

export function actionButtonProps(appearance: ActionAppearance) {
  return appearance === "menu"
    ? {
        variant: "small-menu-item" as const,
        fullWidth: true,
        textAlignLeft: true,
        className: "w-full px-1.5 py-[0.9rem]",
      }
    : { variant: "secondary/medium" as const };
}

export function RevokeApiKeyButton({
  id,
  name,
  canWrite,
  appearance = "menu",
}: {
  id: string;
  name: string;
  canWrite: boolean;
  appearance?: ActionAppearance;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          {...actionButtonProps(appearance)}
          LeadingIcon={NoSymbolIcon}
          leadingIconClassName="text-error"
          disabled={!canWrite}
          tooltip={canWrite ? undefined : "You don't have permission to revoke API keys"}
        >
          Revoke API key…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>Revoke API key</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            Are you sure you want to revoke "{name}"? Requests using this key will stop
            authenticating, and it won't be able to mint new public tokens. Public tokens it already
            minted remain valid until they expire. This can't be reversed.
          </Paragraph>
          <FormButtons
            confirmButton={
              <Form method="post">
                <input type="hidden" name="action" value="revoke" />
                <input type="hidden" name="apiKeyId" value={id} />
                <Button type="submit" variant="danger/medium">
                  Revoke API key
                </Button>
              </Form>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="tertiary/medium">Cancel</Button>
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

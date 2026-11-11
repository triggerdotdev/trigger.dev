import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { InlineCode } from "~/components/code/InlineCode";
import { generateTwoRandomWords } from "~/utils/randomWords";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { Fieldset } from "../primitives/Fieldset";
import { FormButtons } from "../primitives/FormButtons";
import { Hint } from "../primitives/Hint";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Paragraph } from "../primitives/Paragraph";
import { CheckboxWithLabel } from "../primitives/Checkbox";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";

type ModalProps = {
  id: string;
  title: string;
  hasVercelIntegration: boolean;
  isDevelopment: boolean;
  isRootApiKeyHidden?: boolean;
  onSwitchToApiKeys: () => void;
  canLimitAccess?: boolean;
  /** "menu" for a row's ⋮ menu, "button" for a footer. */
  appearance?: "menu" | "button";
};

type ModalContentProps = ModalProps & {
  randomWord: string;
  closeModal: () => void;
};

export function RegenerateApiKeyModal({
  id,
  title,
  hasVercelIntegration,
  isDevelopment,
  isRootApiKeyHidden = false,
  onSwitchToApiKeys,
  canLimitAccess = false,
  appearance = "button",
}: ModalProps) {
  const randomWord = generateTwoRandomWords();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          {...(appearance === "menu"
            ? {
                variant: "small-menu-item" as const,
                fullWidth: true,
                textAlignLeft: true,
                className: "w-full px-1.5 py-[0.9rem]",
              }
            : { variant: "secondary/medium" as const })}
          LeadingIcon={ArrowPathIcon}
        >
          Regenerate…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{`Regenerate ${title} environment key`}</DialogHeader>
        <RegenerateApiKeyModalContent
          id={id}
          title={title}
          hasVercelIntegration={hasVercelIntegration}
          isDevelopment={isDevelopment}
          isRootApiKeyHidden={isRootApiKeyHidden}
          onSwitchToApiKeys={onSwitchToApiKeys}
          canLimitAccess={canLimitAccess}
          randomWord={randomWord}
          closeModal={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

const RegenerateApiKeyModalContent = ({
  id,
  randomWord,
  title,
  hasVercelIntegration,
  isDevelopment,
  isRootApiKeyHidden,
  onSwitchToApiKeys,
  canLimitAccess,
  closeModal,
}: ModalContentProps) => {
  const [confirmationText, setConfirmationText] = useState("");
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting";

  // form submission completed
  if (fetcher.state === "loading") {
    closeModal();
  }

  return (
    <div className="flex flex-col items-center gap-y-4 pt-4">
      {!isRootApiKeyHidden ? (
        <Callout
          variant="warning"
          cta={
            <Button
              variant="warning/small"
              onClick={() => {
                closeModal();
                onSwitchToApiKeys();
              }}
            >
              Replace root key…
            </Button>
          }
        >
          {`Root keys are being phased out. Replace yours with API keys you can ${canLimitAccess ? "limit and " : ""}revoke one at a time, instead of regenerating this one.`}
        </Callout>
      ) : null}
      <Paragraph variant="small" className="w-full">
        {`A new API key will be issued for the ${title} environment. Choose what happens to the previous key.`}
      </Paragraph>
      <fetcher.Form
        method="post"
        action={`/resources/environments/${id}/regenerate-api-key`}
        className="mt-2 w-full"
      >
        {isRootApiKeyHidden ? <input type="hidden" name="rootApiKeyHidden" value="true" /> : null}
        <Fieldset className="w-full">
          <InputGroup className="max-w-full">
            <RadioGroup name="previousKey" defaultValue="grace" className="flex flex-col gap-2">
              <RadioGroupItem
                id="previousKey-grace"
                value="grace"
                variant="description"
                label="Keep the previous key working for 24 hours"
                description={
                  isRootApiKeyHidden
                    ? "Anything still using the previous key keeps working for 24 hours."
                    : "Roll out the new key to your environment variables without downtime. The previous key stops working after 24 hours."
                }
              />
              <RadioGroupItem
                id="previousKey-revoke"
                value="revoke"
                variant="description"
                label="Revoke the previous key immediately"
                description={
                  isRootApiKeyHidden
                    ? "Choose this if the key may have leaked. It stops working now, along with any older key still in its 24-hour window."
                    : "Choose this if the key may have leaked. It stops working now, along with any older key still in its 24-hour window. Deployments and services still using them will fail until they are updated with the new key."
                }
              />
            </RadioGroup>
          </InputGroup>
          <InputGroup className="max-w-full">
            <Input
              type="text"
              placeholder="Confirmation text"
              icon={ExclamationTriangleIcon}
              fullWidth
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
            />
            <Hint>
              Type{" "}
              <InlineCode variant="extra-small" className="select-all">
                {randomWord}
              </InlineCode>{" "}
              to confirm.
            </Hint>
          </InputGroup>
          {hasVercelIntegration && !isDevelopment && (
            <CheckboxWithLabel
              name="syncToVercel"
              variant="simple/small"
              label="Also update TRIGGER_SECRET_KEY in Vercel"
              defaultChecked={true}
              value="on"
            />
          )}
          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant="primary/medium"
                isLoading={isSubmitting}
                disabled={confirmationText !== randomWord || isSubmitting}
              >
                {isSubmitting ? "Regenerating…" : "Regenerate key"}
              </Button>
            }
            cancelButton={
              <Button variant="secondary/medium" type="button" onClick={closeModal}>
                Cancel
              </Button>
            }
          />
        </Fieldset>
      </fetcher.Form>
    </div>
  );
};

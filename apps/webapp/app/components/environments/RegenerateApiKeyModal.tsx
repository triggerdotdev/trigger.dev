import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { generateTwoRandomWords } from "~/utils/randomWords";
import { Button } from "../primitives/Buttons";
import { Callout } from "../primitives/Callout";
import { Fieldset } from "../primitives/Fieldset";
import { FormButtons } from "../primitives/FormButtons";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Paragraph } from "../primitives/Paragraph";
import { CheckboxWithLabel } from "../primitives/Checkbox";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioButton";
import { Spinner } from "../primitives/Spinner";

type ModalProps = {
  id: string;
  title: string;
  hasVercelIntegration: boolean;
  isDevelopment: boolean;
  isRootApiKeyHidden?: boolean;
  onSwitchToApiKeys: () => void;
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
}: ModalProps) {
  const randomWord = generateTwoRandomWords();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="minimal/small" textAlignLeft LeadingIcon={ArrowPathIcon}>
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
        <Callout variant="info">
          <div className="flex flex-col items-start gap-2">
            <Paragraph variant="small">
              For routine key management, use individually managed API keys instead.
            </Paragraph>
            <Button
              variant="secondary/small"
              onClick={() => {
                closeModal();
                onSwitchToApiKeys();
              }}
            >
              Switch to API keys…
            </Button>
          </div>
        </Callout>
      ) : null}
      <Callout variant="warning">
        {`A new API key will be issued for the ${title} environment. Choose what happens to the previous key.`}
      </Callout>
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
            <Paragraph variant="small/bright">Enter this text below to confirm:</Paragraph>
            <Paragraph
              variant="small"
              className="select-all rounded-md border border-grid-bright bg-background-deep px-2 py-1 font-mono"
            >
              {randomWord}
            </Paragraph>
            <Input
              type="text"
              placeholder="Confirmation text"
              fullWidth
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
            />
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
                variant={"primary/medium"}
                LeadingIcon={isSubmitting ? Spinner : undefined}
                disabled={confirmationText !== randomWord}
              >
                Regenerate
              </Button>
            }
            cancelButton={
              <Button variant={"tertiary/medium"} type="button" onClick={closeModal}>
                Cancel
              </Button>
            }
          />
        </Fieldset>
      </fetcher.Form>
    </div>
  );
};

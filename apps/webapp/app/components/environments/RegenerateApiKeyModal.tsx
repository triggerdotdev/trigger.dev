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
import { Spinner } from "../primitives/Spinner";

type ModalProps = {
  id: string;
  title: string;
};

type ModalContentProps = ModalProps & {
  randomWord: string;
  closeModal: () => void;
};

export function RegenerateApiKeyModal({ id, title }: ModalProps) {
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
          randomWord={randomWord}
          closeModal={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

const RegenerateApiKeyModalContent = ({ id, randomWord, title, closeModal }: ModalContentProps) => {
  const [confirmationText, setConfirmationText] = useState("");
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting";

  // form submission completed
  if (fetcher.state === "loading") {
    closeModal();
  }

  return (
    <div className="flex flex-col items-center gap-y-4 pt-4">
      <Callout variant="warning">
        {`Regenerating the keys for this environment will temporarily break any live tasks in the
        ${title} environment until the new API keys are set in the relevant environment variables.`}
      </Callout>
      <fetcher.Form
        method="post"
        action={`/resources/environments/${id}/regenerate-api-key`}
        className="mt-2 w-full"
      >
        <Fieldset className="w-full">
          <InputGroup className="max-w-full">
            <Paragraph variant="small/bright">Enter this text below to confirm:</Paragraph>
            <Paragraph
              variant="small"
              className="select-all rounded-md border border-grid-bright bg-charcoal-900 px-2 py-1 font-mono"
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

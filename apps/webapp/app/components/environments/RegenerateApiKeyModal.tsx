import { ArrowPathIcon, ArrowRightIcon } from "@heroicons/react/20/solid";
import { ExclamationTriangleIcon } from "@heroicons/react/24/solid";
import { useFetcher } from "@remix-run/react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { generateTwoRandomWords } from "~/utils/randomWords";
import { Button } from "../primitives/Buttons";
import { Header1 } from "../primitives/Headers";
import { Input } from "../primitives/Input";
import { Paragraph } from "../primitives/Paragraph";
import { Spinner } from "../primitives/Spinner";
import { Callout } from "../primitives/Callout";
import { Fieldset } from "../primitives/Fieldset";
import { InputGroup } from "../primitives/InputGroup";
import { FormButtons } from "../primitives/FormButtons";

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
        <Button
          variant="minimal/small"
          leadingIconClassName="text-text-dimmed"
          LeadingIcon={ArrowPathIcon}
        >
          Regenerate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{`Regenerate ${title} Environment Key`}</DialogHeader>
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
    <div className="flex flex-col items-center gap-y-5 py-4">
      <Callout variant="warning">
        {`Regenerating the keys for this environment will temporarily break any live Jobs in the
        ${title} Environmentuntil the new API keys are set in the relevant environment variables.`}
      </Callout>
      <fetcher.Form
        method="post"
        action={`/resources/environments/${id}/regenerate-api-key`}
        className="mt-2 w-full"
      >
        <Fieldset className="w-full">
          <InputGroup>
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
                variant={"primary/small"}
                disabled={confirmationText !== randomWord}
              >
                {isSubmitting ? <Spinner color="white" /> : <>Regenerate</>}
              </Button>
            }
            cancelButton={<Button variant={"tertiary/small"}>Cancel</Button>}
          />
        </Fieldset>
      </fetcher.Form>
    </div>
  );
};

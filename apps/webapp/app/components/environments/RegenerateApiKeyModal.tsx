import { ArrowPathIcon } from "@heroicons/react/20/solid";
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
          variant="tertiary/small"
          leadingIconClassName="text-dimmed"
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
    <div className="flex w-full flex-col items-center gap-y-5 pb-4">
      <div className="mt-3 flex gap-x-3 rounded-md border border-ui-border py-4 pl-3 pr-5">
        <ExclamationTriangleIcon className="relative top-1 h-6 w-6 min-w-[2rem] text-amber-500" />
        <Paragraph>
          Regenerating the keys for this environment will temporarily break any live Jobs in the
          <span className="text-bright"> {title} Environment</span> until the new API keys are set
          in the relevant environment variables.
        </Paragraph>
      </div>
      <fetcher.Form
        method="post"
        action={`/resources/environments/${id}/regenerate-api-key`}
        className="mt-2 flex w-full flex-col items-center gap-2"
      >
        <div className="mb-4 flex items-center gap-x-2">
          <Paragraph variant="small/bright">Enter this text below to confirm:</Paragraph>
          <Paragraph
            variant="small"
            className="select-all rounded-md border border-ui-border bg-slate-900 px-2 py-1 font-mono text-bright"
          >
            {randomWord}
          </Paragraph>
        </div>
        <div className="flex items-center">
          <Input
            type="text"
            placeholder="Confirmation text"
            fullWidth
            value={confirmationText}
            onChange={(e) => setConfirmationText(e.target.value)}
            className="rounded-r-none"
            variant="large"
          />
          <Button
            variant="primary/large"
            disabled={confirmationText !== randomWord}
            className="rounded-l-none"
          >
            {isSubmitting ? <Spinner color="white" /> : <>Regenerate</>}
          </Button>
        </div>
      </fetcher.Form>
    </div>
  );
};

import { Button } from "../primitives/Buttons";
import { Dialog, DialogContent, DialogTrigger } from "~/components/primitives/Dialog";
import { Header1, Header2 } from "../primitives/Headers";
import { Input } from "../primitives/Input";
import { NamedIcon } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import { Spinner } from "../primitives/Spinner";
import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import { generateTwoRandomWords } from "~/utils/randomWords";

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
        <Button variant="tertiary/small" leadingIconClassName="text-dimmed" LeadingIcon="key">
          Regenerate
        </Button>
      </DialogTrigger>
      <DialogContent>
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

const RegenerateApiKeyModalContent = ({ id, title, randomWord, closeModal }: ModalContentProps) => {
  const [confirmationText, setConfirmationText] = useState("");
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting";

  // form submission completed
  if (fetcher.state === "loading") {
    closeModal();
  }

  return (
    <div className="flex w-full flex-col items-center gap-y-6">
      <div className="flex justify-center">
        <Header1>{title} Environment</Header1>
      </div>
      <Header2 className="rounded border border-rose-500 bg-rose-500/10 px-3.5 py-2 text-center text-bright">
        Are you sure you want to regenerate the keys <br />
        for this environment?
      </Header2>
      <Paragraph variant="small" className="px-6 text-center">
        <>
          This will temporarily break any live jobs in the
          <span className="strong text-bright"> {title} Environment</span> until the new API keys
          are set in the relevant environment variables.
        </>
      </Paragraph>
      <fetcher.Form
        method="post"
        action={`/resources/environments/${id}/regenerate-api-key`}
        className="mt-2 flex w-full flex-col items-center gap-2"
      >
        <Paragraph variant="small" className="font-medium">
          To confirm, please enter the text:{" "}
          <span className="font-bold text-bright">{randomWord}</span>
        </Paragraph>
        <Input
          type="text"
          placeholder="Confirmation Text"
          fullWidth={false}
          value={confirmationText}
          onChange={(e) => setConfirmationText(e.target.value)}
        />
        <Button
          variant="primary/large"
          fullWidth
          className="mt-4"
          disabled={confirmationText !== randomWord}
        >
          {isSubmitting ? (
            <Spinner color="white" />
          ) : (
            <>
              <NamedIcon
                name="key"
                className="mr-1.5 h-4 w-4 text-bright transition group-hover:text-bright"
              />
              Regenerate API Keys
            </>
          )}
        </Button>
      </fetcher.Form>
    </div>
  );
};

import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpinnerWhite } from "~/components/primitives/Spinner";

type CheckBatchCompletionDialogProps = {
  batchId: string;
  redirectPath: string;
};

export function CheckBatchCompletionDialog({
  batchId,
  redirectPath,
}: CheckBatchCompletionDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/batches/${batchId}/check-completion`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="check-completion">
      <DialogHeader>Try and resume batch</DialogHeader>
      <div className="flex flex-col gap-3 pt-3">
        <Paragraph>
          In rare cases, parent runs don't continue after child runs have completed.
        </Paragraph>
        <Paragraph>
          If this doesn't help, please get in touch. We are working on a permanent fix for this.
        </Paragraph>
        <FormButtons
          confirmButton={
            <Form action={`/resources/batches/${batchId}/check-completion`} method="post">
              <Button
                type="submit"
                name="redirectUrl"
                value={redirectPath}
                variant="primary/medium"
                LeadingIcon={isLoading ? SpinnerWhite : undefined}
                disabled={isLoading}
                shortcut={{ modifiers: ["mod"], key: "enter" }}
              >
                {isLoading ? "Attempting resume..." : "Attempt resume"}
              </Button>
            </Form>
          }
          cancelButton={
            <DialogClose asChild>
              <Button variant={"tertiary/medium"}>Cancel</Button>
            </DialogClose>
          }
        />
      </div>
    </DialogContent>
  );
}

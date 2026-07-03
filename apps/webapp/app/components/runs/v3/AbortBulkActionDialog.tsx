import { NoSymbolIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpinnerWhite } from "~/components/primitives/Spinner";

type AbortBulkActionDialogProps = {
  // The abort action route to POST to (the bulk action detail path).
  formAction: string;
  // Fired on submit so a parent controlling the Radix Dialog can close it
  // without wrapping the submit button in `DialogClose` — that wrapper races
  // submit (close fires first, unmounts the form, and the abort POST never
  // lands). Optional so uncontrolled call sites still type-check.
  onAbortSubmitted?: () => void;
};

export function AbortBulkActionDialog({
  formAction,
  onAbortSubmitted,
}: AbortBulkActionDialogProps) {
  const navigation = useNavigation();

  const isLoading = navigation.formAction === formAction && navigation.formMethod === "POST";

  return (
    <DialogContent key="abort">
      <DialogHeader>Abort this bulk action?</DialogHeader>
      <div className="flex flex-col gap-3 pt-3">
        <Paragraph>
          Aborting stops this bulk action from processing any remaining runs. Runs it has already
          processed won't be affected.
        </Paragraph>
        <FormButtons
          confirmButton={
            <Form action={formAction} method="post" onSubmit={() => onAbortSubmitted?.()}>
              <Button
                type="submit"
                variant="danger/medium"
                LeadingIcon={isLoading ? SpinnerWhite : NoSymbolIcon}
                disabled={isLoading}
                shortcut={{ modifiers: ["mod"], key: "enter" }}
              >
                {isLoading ? "Aborting..." : "Abort bulk action"}
              </Button>
            </Form>
          }
          cancelButton={
            <DialogClose asChild>
              <Button variant={"tertiary/medium"}>Close</Button>
            </DialogClose>
          }
        />
      </div>
    </DialogContent>
  );
}

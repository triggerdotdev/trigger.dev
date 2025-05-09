import { NoSymbolIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpinnerWhite } from "~/components/primitives/Spinner";

type CancelRunDialogProps = {
  runFriendlyId: string;
  redirectPath: string;
};

export function CancelRunDialog({ runFriendlyId, redirectPath }: CancelRunDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/taskruns/${runFriendlyId}/cancel`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="cancel">
      <DialogHeader>Cancel this run?</DialogHeader>
      <div className="flex flex-col gap-3 pt-3">
        <Paragraph>
          Canceling a run will stop execution, along with any executing subtasks.
        </Paragraph>
        <FormButtons
          confirmButton={
            <Form action={`/resources/taskruns/${runFriendlyId}/cancel`} method="post">
              <Button
                type="submit"
                name="redirectUrl"
                value={redirectPath}
                variant="danger/medium"
                LeadingIcon={isLoading ? SpinnerWhite : NoSymbolIcon}
                disabled={isLoading}
                shortcut={{ modifiers: ["mod"], key: "enter" }}
              >
                {isLoading ? "Canceling..." : "Cancel run"}
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

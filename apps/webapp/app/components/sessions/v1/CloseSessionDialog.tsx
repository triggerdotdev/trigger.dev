import { XCircleIcon } from "@heroicons/react/24/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpinnerWhite } from "~/components/primitives/Spinner";

type CloseSessionDialogProps = {
  sessionParam: string;
  environmentId: string;
  redirectPath: string;
};

export function CloseSessionDialog({
  sessionParam,
  environmentId,
  redirectPath,
}: CloseSessionDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/sessions/${encodeURIComponent(sessionParam)}/close`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="close-session">
      <DialogHeader>Close this session?</DialogHeader>
      <div className="flex flex-col gap-3 pt-3">
        <Paragraph>
          Closing a session is permanent. The session will no longer accept new input or trigger
          new runs. Any in-flight run continues until it finishes on its own.
        </Paragraph>
        <Form action={formAction} method="post" className="flex flex-col gap-3">
          <input type="hidden" name="redirectUrl" value={redirectPath} />
          <input type="hidden" name="environmentId" value={environmentId} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="close-session-reason">Reason (optional)</Label>
            <Input
              id="close-session-reason"
              name="reason"
              placeholder="e.g. user signed out, ticket resolved"
              variant="medium"
              spellCheck={false}
              autoFocus
            />
          </div>
          <FormButtons
            confirmButton={
              <Button
                type="submit"
                variant="danger/medium"
                LeadingIcon={isLoading ? SpinnerWhite : XCircleIcon}
                disabled={isLoading}
                shortcut={{ modifiers: ["mod"], key: "enter" }}
              >
                {isLoading ? "Closing..." : "Close session"}
              </Button>
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant={"tertiary/medium"}>Cancel</Button>
              </DialogClose>
            }
          />
        </Form>
      </div>
    </DialogContent>
  );
}

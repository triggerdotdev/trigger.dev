import { StopCircleIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";

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
      <DialogDescription>
        Canceling a run will stop execution. If you want to run this later you will have to replay
        the entire run with the original payload.
      </DialogDescription>
      <DialogFooter>
        <Form action={`/resources/taskruns/${runFriendlyId}/cancel`} method="post">
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="danger/small"
            LeadingIcon={isLoading ? "spinner-white" : StopCircleIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["meta"], key: "enter" }}
          >
            {isLoading ? "Canceling..." : "Cancel run"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

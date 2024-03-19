import { StopCircleIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
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
  const cancelFetcher = useFetcher();

  return (
    <DialogContent>
      <DialogHeader>Cancel this run?</DialogHeader>
      <DialogDescription>
        Canceling a run will stop execution. If you want to run this later you will have to replay
        the entire run with the original payload.
      </DialogDescription>
      <DialogFooter>
        <cancelFetcher.Form action={`/resources/taskruns/${runFriendlyId}/cancel`} method="post">
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="danger/small"
            LeadingIcon={cancelFetcher.state === "idle" ? StopCircleIcon : "spinner-white"}
            disabled={cancelFetcher.state !== "idle"}
            shortcut={{ modifiers: ["meta"], key: "enter" }}
          >
            {cancelFetcher.state === "idle" ? "Cancel run" : "Canceling..."}
          </Button>
        </cancelFetcher.Form>
      </DialogFooter>
    </DialogContent>
  );
}

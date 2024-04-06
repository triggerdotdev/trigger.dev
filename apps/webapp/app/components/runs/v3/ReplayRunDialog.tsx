import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";

type ReplayRunDialogProps = {
  runFriendlyId: string;
  failedRedirect: string;
};

export function ReplayRunDialog({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  const replayFetcher = useFetcher();

  return (
    <DialogContent>
      <DialogHeader>Replay this run?</DialogHeader>
      <DialogDescription>
        Replaying a run will create a new run with the same payload and environment as the original.
      </DialogDescription>
      <DialogFooter>
        <replayFetcher.Form action={`/resources/taskruns/${runFriendlyId}/replay`} method="post">
          <input type="hidden" name="failedRedirect" value={failedRedirect} />
          <Button
            type="submit"
            variant="primary/small"
            LeadingIcon={replayFetcher.state === "idle" ? ArrowPathIcon : "spinner-white"}
            disabled={replayFetcher.state !== "idle"}
            shortcut={{ modifiers: ["meta"], key: "enter" }}
          >
            {replayFetcher.state === "idle" ? "Replay run" : "Replaying..."}
          </Button>
        </replayFetcher.Form>
      </DialogFooter>
    </DialogContent>
  );
}

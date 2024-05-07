import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher, useNavigation } from "@remix-run/react";
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
  const navigation = useNavigation();

  const formAction = `/resources/taskruns/${runFriendlyId}/replay`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="replay">
      <DialogHeader>Replay this run?</DialogHeader>
      <DialogDescription>
        Replaying a run will create a new run with the same payload and environment as the original.
      </DialogDescription>
      <DialogFooter>
        <Form action={formAction} method="post">
          <input type="hidden" name="failedRedirect" value={failedRedirect} />
          <Button
            type="submit"
            variant="primary/small"
            LeadingIcon={isLoading ? "spinner-white" : ArrowPathIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["meta"], key: "enter" }}
          >
            {isLoading ? "Replaying..." : "Replay run"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

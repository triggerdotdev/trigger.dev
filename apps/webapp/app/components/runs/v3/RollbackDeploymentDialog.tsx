import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { SpinnerWhite } from "~/components/primitives/Spinner";

type RollbackDeploymentDialogProps = {
  projectId: string;
  deploymentShortCode: string;
  redirectPath: string;
};

export function RollbackDeploymentDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RollbackDeploymentDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/rollback`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="rollback">
      <DialogHeader>Rollback to this deployment?</DialogHeader>
      <DialogDescription>
        This deployment will become the default for all future runs. Tasks triggered but not
        included in this deploy will remain queued until you roll back to or create a new deployment
        with these tasks included.
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <Form
          action={`/resources/${projectId}/deployments/${deploymentShortCode}/rollback`}
          method="post"
        >
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="primary/medium"
            LeadingIcon={isLoading ? SpinnerWhite : ArrowPathIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Rolling back..." : "Rollback deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

export function PromoteDeploymentDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RollbackDeploymentDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/promote`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="promote">
      <DialogHeader>Promote this deployment?</DialogHeader>
      <DialogDescription>
        This deployment will become the default for all future runs not explicitly tied to a
        specific deployment.
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <Form
          action={`/resources/${projectId}/deployments/${deploymentShortCode}/promote`}
          method="post"
        >
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="primary/medium"
            LeadingIcon={isLoading ? SpinnerWhite : ArrowPathIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Promoting..." : "Promote deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

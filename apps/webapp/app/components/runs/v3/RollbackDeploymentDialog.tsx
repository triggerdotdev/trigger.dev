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
      <DialogHeader>Roll back to this deployment?</DialogHeader>
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
            LeadingIcon={isLoading ? "spinner-white" : ArrowPathIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Rolling back..." : "Roll back deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

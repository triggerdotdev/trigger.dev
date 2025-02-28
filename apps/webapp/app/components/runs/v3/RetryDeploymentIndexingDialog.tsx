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

type RetryDeploymentIndexingDialogProps = {
  projectId: string;
  deploymentShortCode: string;
  redirectPath: string;
};

export function RetryDeploymentIndexingDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RetryDeploymentIndexingDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/retry-indexing`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="retry-indexing">
      <DialogHeader>Retry indexing this deployment?</DialogHeader>
      <DialogDescription>
        Retrying can be useful if indexing failed due to missing environment variables. Make sure
        you set them before retrying. In most other cases, indexing will keep failing until you fix
        any errors and re-deploy.
      </DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <Form
          action={`/resources/${projectId}/deployments/${deploymentShortCode}/retry-indexing`}
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
            {isLoading ? "Retrying..." : "Retry indexing"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

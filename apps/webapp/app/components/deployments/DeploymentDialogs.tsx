import { ArrowPathIcon, NoSymbolIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useFetcher, useNavigation } from "@remix-run/react";
import { useEffect } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { Button } from "~/components/primitives/Buttons";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SpinnerWhite } from "~/components/primitives/Spinner";

// Shared by the deployments list and the deployment page. They live here rather than in the list
// route so the deployment page doesn't load the whole list page's code.

export function UserTag({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  return (
    <div className="flex items-center gap-1">
      <UserAvatar
        avatarUrl={avatarUrl}
        name={name}
        className="h-4 w-4 group-hover/table-row:text-text-bright"
      />
      <Paragraph variant="extra-small" className="group-hover/table-row:text-text-bright">
        {name}
      </Paragraph>
    </div>
  );
}

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
        This deployment will become the default for all future runs.
      </DialogDescription>
      <RollbackMissingTasks action={formAction} />
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

/**
 * The tasks this rollback would drop. Rendered inside the dialog's content, which only mounts
 * while the dialog is open, so it loads on each open and not with the page.
 */
function RollbackMissingTasks({ action }: { action: string }) {
  const missingTasksFetcher = useFetcher<{ missingTasks: string[] }>();
  useEffect(() => {
    missingTasksFetcher.load(action);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open; the fetcher changes identity on every state change
  }, [action]);
  const missingTasks = missingTasksFetcher.data?.missingTasks ?? [];

  if (missingTasks.length === 0) return null;

  return (
    <DialogDescription>
      {missingTasks.length === 1 ? "This task isn't" : "These tasks aren't"} in this deploy. Runs
      triggered for {missingTasks.length === 1 ? "it" : "them"} will wait until a new deploy
      includes {missingTasks.length === 1 ? "it" : "them"}:{" "}
      {missingTasks.map((slug, index) => (
        <span key={slug}>
          {index > 0 && ", "}
          <InlineCode variant="extra-small">{slug}</InlineCode>
        </span>
      ))}
    </DialogDescription>
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

export function CancelDeploymentDialog({
  projectId,
  deploymentShortCode,
  redirectPath,
}: RollbackDeploymentDialogProps) {
  const navigation = useNavigation();

  const formAction = `/resources/${projectId}/deployments/${deploymentShortCode}/cancel`;
  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent key="cancel">
      <DialogHeader>Cancel this deployment?</DialogHeader>
      <DialogDescription>Canceling a deployment cannot be undone. Are you sure?</DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="tertiary/medium">Back</Button>
        </DialogClose>
        <Form action={formAction} method="post">
          <Button
            type="submit"
            name="redirectUrl"
            value={redirectPath}
            variant="danger/medium"
            LeadingIcon={isLoading ? SpinnerWhite : NoSymbolIcon}
            disabled={isLoading}
            shortcut={{ modifiers: ["mod"], key: "enter" }}
          >
            {isLoading ? "Canceling..." : "Cancel deployment"}
          </Button>
        </Form>
      </DialogFooter>
    </DialogContent>
  );
}

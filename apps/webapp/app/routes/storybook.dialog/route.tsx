import {
  Alert,
  AlertCancel,
  AlertContent,
  AlertDescription,
  AlertFooter,
  AlertHeader,
  AlertTitle,
  AlertTrigger,
} from "~/components/primitives/Alert";
import { Button } from "~/components/primitives/Buttons";
import {
  DialogHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

export default function Story_() {
  return (
    <StoryPage
      componentNames={["Dialog.tsx", "Alert.tsx"]}
      title="Dialog"
      description="Modal dialogs, plus the alert dialog for destructive confirmations."
    >
      <StorySection title="Dialog">
        <StoryGrid min="13rem">
          <Story label="Standard">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary/small">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Are you absolutely sure?</DialogTitle>
                </DialogHeader>
                <DialogDescription>
                  This action cannot be undone. This will permanently delete your account and remove
                  your data from our servers.
                </DialogDescription>
              </DialogContent>
            </Dialog>
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection
        title="Alert dialog"
        description="Blocks interaction until the user confirms or cancels."
      >
        <StoryGrid min="13rem">
          <Story label="Destructive confirm">
            <Alert>
              <AlertTrigger asChild>
                <Button variant="danger/small">Delete project</Button>
              </AlertTrigger>
              <AlertContent>
                <AlertHeader>
                  <AlertTitle>Delete this project?</AlertTitle>
                  <AlertDescription>
                    All runs, schedules and environment variables will be permanently removed.
                  </AlertDescription>
                </AlertHeader>
                <AlertFooter>
                  <AlertCancel asChild>
                    <Button variant="tertiary/medium">Cancel</Button>
                  </AlertCancel>
                </AlertFooter>
              </AlertContent>
            </Alert>
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}

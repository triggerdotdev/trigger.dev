import { useState } from "react";
import { ProfilePhotoEditor } from "~/components/ProfilePhotoEditor";
import { Button } from "~/components/primitives/Buttons";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

function EditorStory({ isSaving }: { isSaving?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary/small" onClick={() => setOpen(true)}>
        Change photo
      </Button>
      <ProfilePhotoEditor
        open={open}
        onOpenChange={setOpen}
        onSave={() => setOpen(false)}
        isSaving={isSaving}
      />
    </>
  );
}

export default function Story_() {
  return (
    <StoryPage
      componentNames={["ProfilePhotoEditor.tsx"]}
      title="Profile photo editor"
      description="Pick an image, drag and zoom it inside a circular mask, then save the cropped result."
    >
      <StorySection title="Editor">
        <StoryGrid min="13rem">
          <Story label="Default">
            <EditorStory />
          </Story>
          <Story label="Saving">
            <EditorStory isSaving />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}

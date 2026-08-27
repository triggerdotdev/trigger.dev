import { useState } from "react";
import { ProfilePhotoEditor } from "~/components/ProfilePhotoEditor";
import { Button } from "~/components/primitives/Buttons";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

// A data URI skips the `?raw` fetch, so the story needs no backend. Explicit
// width/height too, or the SVG has no intrinsic size to crop against.
const PLACEHOLDER_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#5850EC"/><circle cx="128" cy="100" r="48" fill="#E1E1E6"/><circle cx="128" cy="248" r="84" fill="#E1E1E6"/></svg>`
  );

function EditorStory({
  isSaving,
  currentAvatarUrl,
  withRemove,
}: {
  isSaving?: boolean;
  currentAvatarUrl?: string;
  withRemove?: boolean;
}) {
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
        currentAvatarUrl={currentAvatarUrl}
        onRemove={withRemove ? () => setOpen(false) : undefined}
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
      description="Choose or drop an image, drag and zoom it inside a circular mask, then save the cropped result."
    >
      <StorySection title="Editor">
        <StoryGrid min="13rem">
          <Story label="No picture yet">
            <EditorStory />
          </Story>
          <Story label="Existing picture in the cropper">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} />
          </Story>
          <Story label="Existing picture, removable">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} withRemove />
          </Story>
          <Story label="Saving">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} withRemove isSaving />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}

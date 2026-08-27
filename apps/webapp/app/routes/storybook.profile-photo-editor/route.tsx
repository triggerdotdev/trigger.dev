import { useState } from "react";
import { ProfilePhotoEditor } from "~/components/ProfilePhotoEditor";
import { Button } from "~/components/primitives/Buttons";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

// Data URI, not a remote image: the document `img-src` CSP allowlist has no
// placeholder host.
const PLACEHOLDER_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#5850EC"/><circle cx="64" cy="50" r="24" fill="#E1E1E6"/><circle cx="64" cy="124" r="42" fill="#E1E1E6"/></svg>`
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
          <Story label="Current picture">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} />
          </Story>
          <Story label="Current picture, removable">
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

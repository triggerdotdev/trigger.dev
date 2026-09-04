import { useState } from "react";
import { ProfilePhotoEditor } from "~/components/ProfilePhotoEditor";
import { Button } from "~/components/primitives/Buttons";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

// Data URI, not a remote image: the document `img-src` CSP allowlist has no
// placeholder host.
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
      description="The saved picture shows as it is. Choose or drop a new image to crop and zoom it inside a circular mask, then save."
    >
      <StorySection title="Editor">
        <StoryGrid min="13rem">
          <Story label="No picture yet">
            <EditorStory />
          </Story>
          <Story label="Saved picture, shown statically">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} />
          </Story>
          <Story label="Saved picture, removable">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} withRemove />
          </Story>
          <Story label="Saved picture that fails to load">
            <EditorStory currentAvatarUrl="/storybook-missing-avatar.png" withRemove />
          </Story>
          <Story label="Submitting, buttons disabled">
            <EditorStory currentAvatarUrl={PLACEHOLDER_AVATAR} withRemove isSaving />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}

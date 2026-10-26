import { GalleryPage } from "../storybook.agent-ui/gallery";
import { WIZARD_STATES } from "./wizard-stories";

export default function Story() {
  return (
    <GalleryPage page="wizard" states={WIZARD_STATES} componentNames={["ChatWizardCard.tsx"]} />
  );
}

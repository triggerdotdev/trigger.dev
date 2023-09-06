import { ChatBubbleLeftRightIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { projectSetupPath } from "~/utils/pathBuilder";
import { PageGradient } from "./PageGradient";
import { useProject } from "~/hooks/useProject";
import { useOrganization } from "~/hooks/useOrganizations";

export function SetupNuxt() {
  const project = useProject();
  const organization = useOrganization();

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <Header1 spacing className="text-bright">
            Framework not available yet
          </Header1>
          <div className="flex items-center gap-2">
            <LinkButton
              to={projectSetupPath(organization, project)}
              variant="tertiary/small"
              LeadingIcon={Squares2X2Icon}
            >
              Choose a different framework
            </LinkButton>
            <Feedback
              button={
                <Button variant="tertiary/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                  I'm stuck!
                </Button>
              }
              defaultValue="help"
            />
          </div>
        </div>
      </div>
    </PageGradient>
  );
}

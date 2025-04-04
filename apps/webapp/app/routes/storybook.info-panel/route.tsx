import {
  BeakerIcon,
  BellAlertIcon,
  BookOpenIcon,
  ClockIcon,
  InformationCircleIcon,
  PlusIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { LinkButton } from "~/components/primitives/Buttons";

export default function Story() {
  return (
    <div className="flex h-full flex-col gap-12 p-12">
      <div className="grid grid-cols-2 gap-8">
        {/* Basic Info Panel */}
        <InfoPanel
          title="Basic Info Panel"
          icon={InformationCircleIcon}
          iconClassName="text-blue-500"
        >
          This is a basic info panel with title and default variant
        </InfoPanel>

        {/* Info Panel with Button */}
        <InfoPanel
          title="Info with Button"
          icon={InformationCircleIcon}
          iconClassName="text-blue-500"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              Learn More
            </LinkButton>
          }
        >
          This panel includes a button in the top-right corner
        </InfoPanel>

        {/* Upgrade Variant with Button */}
        <InfoPanel
          title="Upgrade Panel"
          icon={BellAlertIcon}
          iconClassName="text-red-500"
          variant="upgrade"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              Upgrade Now
            </LinkButton>
          }
        >
          This panel uses the upgrade variant with a call-to-action button
        </InfoPanel>

        {/* Minimal Variant */}
        <InfoPanel icon={ClockIcon} iconClassName="text-sun-500" variant="minimal">
          A minimal variant without a title
        </InfoPanel>

        {/* Task Panel with Action */}
        <InfoPanel
          title="Task Status"
          icon={TaskIcon}
          iconClassName="text-blue-500"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              View Tasks
            </LinkButton>
          }
        >
          A panel showing task information with a view action
        </InfoPanel>

        {/* Getting Started Panel */}
        <InfoPanel
          title="Getting Started"
          icon={RocketLaunchIcon}
          iconClassName="text-purple-500"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              Start Tutorial
            </LinkButton>
          }
        >
          Begin your journey with our quick start guide
        </InfoPanel>

        {/* Deployment Panel with Button */}
        <InfoPanel
          title="Deployment Status"
          icon={ServerStackIcon}
          iconClassName="text-indigo-500"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              Deploy Now
            </LinkButton>
          }
        >
          Ready to deploy your changes to production
        </InfoPanel>

        {/* Create New Panel */}
        <InfoPanel
          title="Create New"
          icon={PlusIcon}
          iconClassName="text-green-500"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              New Project
            </LinkButton>
          }
        >
          Start a new project with our guided setup
        </InfoPanel>

        {/* Batches Panel */}
        <InfoPanel title="Batch Operations" icon={Squares2X2Icon} iconClassName="text-purple-500">
          Information about batch processing
        </InfoPanel>

        {/* Documentation Panel with Link */}
        <InfoPanel
          title="Documentation"
          icon={BookOpenIcon}
          iconClassName="text-green-500"
          accessory={
            <LinkButton to="#" variant="secondary/small">
              View Docs
            </LinkButton>
          }
        >
          Access our comprehensive documentation
        </InfoPanel>
      </div>
    </div>
  );
}

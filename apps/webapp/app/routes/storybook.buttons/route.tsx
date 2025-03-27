import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUturnLeftIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  GlobeAltIcon,
  LightBulbIcon,
  NoSymbolIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { EnvelopeIcon } from "@heroicons/react/24/solid";
import {
  AirtableIcon,
  GitHubDarkIcon,
  GitHubLightIcon,
  SlackIcon,
} from "@trigger.dev/companyicons";
import { Button } from "~/components/primitives/Buttons";
import { Header1, Header3 } from "~/components/primitives/Headers";
import { Spinner } from "~/components/primitives/Spinner";

export default function Story() {
  const isSelected = true;
  const disabled = true;
  return (
    <div className="bg-background-dimmed p-12">
      <Header1 className="mb-2">Small buttons</Header1>
      <div className="grid grid-cols-4 gap-8 border-b border-charcoal-700 pb-8">
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Basic</Header3>
          <Button variant="primary/small">Primary button</Button>
          <Button variant="secondary/small">Secondary button</Button>
          <Button variant="tertiary/small">Tertiary button</Button>
          <Button variant="minimal/small">Minimal button</Button>
          <Button variant="danger/small">Danger button</Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon left</Header3>
          <Button variant="primary/small" LeadingIcon={ArrowLeftIcon}>
            Primary button
          </Button>
          <Button variant="secondary/small" LeadingIcon={ArrowLeftIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/small" LeadingIcon={ArrowLeftIcon}>
            Tertiary button
          </Button>
          <Button variant="minimal/small" LeadingIcon={ArrowLeftIcon}>
            Minimal button
          </Button>
          <Button variant="danger/small" LeadingIcon={ArrowLeftIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon right</Header3>
          <Button variant="primary/small" TrailingIcon={ArrowRightIcon}>
            Primary button
          </Button>
          <Button variant="secondary/small" TrailingIcon={ArrowRightIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/small" TrailingIcon={ArrowRightIcon}>
            Tertiary button
          </Button>
          <Button variant="minimal/small" TrailingIcon={ArrowRightIcon}>
            Minimal button
          </Button>
          <Button variant="danger/small" TrailingIcon={ArrowRightIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Shortcut</Header3>
          <Button variant="primary/small" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Primary button
          </Button>
          <Button variant="secondary/small" shortcut={{ key: "f" }}>
            Secondary button
          </Button>
          <Button variant="tertiary/small" shortcut={{ key: "i" }}>
            Tertiary button
          </Button>
          <Button variant="minimal/small" shortcut={{ key: "i" }}>
            Minimal button
          </Button>
          <Button variant="danger/small" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Named icon</Header3>
          <Button LeadingIcon={AirtableIcon} variant="primary/small">
            Connect to Airtable
          </Button>
          <Button LeadingIcon={GitHubDarkIcon} variant="primary/small">
            Connect to GitHub
          </Button>
          <Button TrailingIcon={SlackIcon} variant="secondary/small">
            Connect to Slack
          </Button>
          <Button TrailingIcon={ExclamationTriangleIcon} variant="secondary/small">
            Trailing icon
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Loading</Header3>
          <Button
            variant="primary/small"
            LeadingIcon={<Spinner color="white" className="size-3.5" />}
          >
            Loading Primary…
          </Button>
          <Button variant="secondary/small" LeadingIcon={Spinner}>
            Loading Secondary…
          </Button>
          <Button variant="tertiary/small" LeadingIcon={Spinner}>
            Loading Tertiary…
          </Button>
          <Button variant="minimal/small" LeadingIcon={Spinner}>
            Loading Minimal…
          </Button>
          <Button
            variant="danger/small"
            LeadingIcon={<Spinner color="white" className="size-3.5" />}
          >
            Loading Danger…
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Disabled</Header3>
          <Button variant="primary/small" disabled>
            Primary button
          </Button>
          <Button variant="secondary/small" disabled>
            Secondary button
          </Button>
          <Button variant="tertiary/small" disabled>
            Tertiary button
          </Button>
          <Button variant="minimal/small" disabled>
            Minimal button
          </Button>
          <Button variant="danger/small" disabled>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon only</Header3>
          <Button variant="primary/small" LeadingIcon={ArrowRightIcon} />
          <Button variant="secondary/small" LeadingIcon={LightBulbIcon} />
          <Button variant="tertiary/small" LeadingIcon={ExclamationTriangleIcon} />
          <Button variant="minimal/small" LeadingIcon={ExclamationTriangleIcon} />
          <Button variant="danger/small" LeadingIcon={ExclamationTriangleIcon} />
        </div>
      </div>
      <Header1 className="mb-2 mt-8">Medium buttons</Header1>
      <div className="grid grid-cols-4 gap-8 border-b border-charcoal-700 pb-8">
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Basic</Header3>
          <Button variant="primary/medium">Primary button</Button>
          <Button variant="secondary/medium">Secondary button</Button>
          <Button variant="tertiary/medium">Tertiary button</Button>
          <Button variant="danger/medium">Danger button</Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon left</Header3>
          <Button variant="primary/medium" LeadingIcon={ArrowLeftIcon}>
            Primary button
          </Button>
          <Button variant="secondary/medium" LeadingIcon={ArrowLeftIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/medium" LeadingIcon={ArrowLeftIcon}>
            Tertiary button
          </Button>
          <Button variant="minimal/medium" LeadingIcon={ArrowLeftIcon}>
            Minimal button
          </Button>
          <Button variant="danger/medium" LeadingIcon={ArrowLeftIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon right</Header3>
          <Button variant="primary/medium" TrailingIcon={ArrowRightIcon}>
            Primary button
          </Button>
          <Button variant="secondary/medium" TrailingIcon={ArrowRightIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/medium" TrailingIcon={ArrowRightIcon}>
            Tertiary button
          </Button>
          <Button variant="minimal/medium" TrailingIcon={ArrowRightIcon}>
            Minimal button
          </Button>
          <Button variant="danger/medium" TrailingIcon={ArrowRightIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Shortcut</Header3>
          <Button variant="primary/medium" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Primary button
          </Button>
          <Button variant="secondary/medium" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Secondary button
          </Button>
          <Button variant="tertiary/medium" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Tertiary button
          </Button>
          <Button variant="minimal/medium" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Minimal button
          </Button>
          <Button variant="danger/medium" shortcut={{ key: "s", modifiers: ["mod"] }}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Named icon</Header3>
          <Button LeadingIcon={AirtableIcon} variant="primary/medium">
            Connect to Airtable
          </Button>
          <Button LeadingIcon={GitHubDarkIcon} variant="primary/medium">
            Connect to GitHub
          </Button>
          <Button TrailingIcon={SlackIcon} variant="secondary/medium">
            Connect to Slack
          </Button>
          <Button TrailingIcon={ExclamationTriangleIcon} variant="secondary/medium">
            Connect to Slack
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Loading</Header3>
          <Button
            variant="primary/medium"
            LeadingIcon={<Spinner color="white" className="size-4" />}
          >
            Loading Primary…
          </Button>
          <Button variant="secondary/medium" LeadingIcon={Spinner}>
            Loading Secondary…
          </Button>
          <Button variant="tertiary/medium" LeadingIcon={Spinner}>
            Loading Tertiary…
          </Button>
          <Button variant="minimal/medium" LeadingIcon={Spinner}>
            Loading Minimal…
          </Button>
          <Button
            variant="danger/medium"
            LeadingIcon={<Spinner color="white" className="size-4" />}
          >
            Loading Danger…
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Disabled</Header3>
          <Button variant="primary/medium" disabled>
            Primary button
          </Button>
          <Button variant="secondary/medium" disabled>
            Secondary button
          </Button>
          <Button variant="tertiary/medium" disabled>
            Tertiary button
          </Button>
          <Button variant="tertiary/medium" disabled>
            Minimal button
          </Button>
          <Button variant="danger/medium" disabled>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon only</Header3>
          <Button variant="primary/medium" LeadingIcon={ArrowRightIcon} />
          <Button variant="secondary/medium" LeadingIcon={LightBulbIcon} />
          <Button variant="tertiary/medium" LeadingIcon={ExclamationTriangleIcon} />
          <Button variant="minimal/medium" LeadingIcon={ExclamationTriangleIcon} />
          <Button variant="danger/medium" LeadingIcon={ExclamationTriangleIcon} />
        </div>
      </div>
      <Header1 className="mb-2 mt-8">Large buttons</Header1>
      <div className="grid grid-cols-1 gap-8 pb-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col items-start gap-2">
            <Button variant="primary/large" fullWidth>
              <GitHubLightIcon className={"mr-1.5 size-[1.2rem]"} />
              <span className="text-text-bright">Continue with GitHub</span>
            </Button>
            <Button variant="secondary/large" fullWidth>
              <EnvelopeIcon className={"mr-1.5 size-[1.2rem] text-text-bright transition"} />
              <span className="text-text-bright">Continue with Email</span>
            </Button>
            <Button variant="tertiary/large" fullWidth>
              <GitHubLightIcon className={"mr-1.5 size-[1.2rem]"} />
              <span className="text-text-bright">Continue with GitHub</span>
            </Button>
            <Button variant="danger/large" fullWidth>
              <TrashIcon
                className={
                  "mr-1.5 h-4 w-4 text-text-bright transition group-hover:text-text-bright"
                }
              />
              <span className="text-text-bright">This is a delete button</span>
            </Button>
          </div>
        </div>
      </div>
      <Header1 className="mb-2 mt-8">Extra Large buttons</Header1>
      <div className="grid grid-cols-1 gap-8 pb-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col items-start gap-2">
            <Button variant="primary/extra-large" fullWidth>
              <GitHubLightIcon className={"mr-1.5 size-5"} />
              <span className="text-text-bright">Continue with GitHub</span>
            </Button>
            <Button variant="secondary/extra-large" fullWidth>
              <EnvelopeIcon className={"mr-1.5 h-5 w-5 text-text-bright transition"} />
              <span className="text-text-bright">Continue with Email</span>
            </Button>
            <Button variant="tertiary/extra-large" fullWidth>
              <GitHubLightIcon className={"mr-1.5 size-5"} />
              <span className="text-text-bright">Continue with GitHub</span>
            </Button>
            <Button variant="danger/extra-large" fullWidth>
              <TrashIcon
                className={"mr-1.5 size-5 text-text-bright transition group-hover:text-text-bright"}
              />
              <span className="text-text-bright">This is a delete button</span>
            </Button>
          </div>
        </div>
      </div>
      <Header1 className="mb-2 mt-8">Menu items</Header1>
      <div className="grid grid-cols-1">
        <div className="flex flex-col items-start gap-1 rounded border border-charcoal-800 bg-charcoal-850 p-1">
          <Button variant="menu-item" fullWidth textAlignLeft LeadingIcon={FolderIcon}>
            Acme Inc.
          </Button>
          <Button variant="menu-item" fullWidth textAlignLeft LeadingIcon={PlusIcon}>
            New Project
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon={GlobeAltIcon}
            TrailingIcon={isSelected ? CheckIcon : undefined}
            className={isSelected ? "bg-charcoal-750 group-hover:bg-charcoal-750" : undefined}
          >
            Item enabled
          </Button>
          <Button variant="menu-item" fullWidth textAlignLeft>
            When a Stripe payment fails re-engage the customer
          </Button>
          <Button variant="menu-item" fullWidth textAlignLeft LeadingIcon={Spinner}>
            In Progress
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon={ArrowUturnLeftIcon}
            leadingIconClassName="text-text-dimmed"
          >
            Latest run payload
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon={NoSymbolIcon}
            leadingIconClassName="text-text-dimmed"
            disabled
            className={disabled ? "group-hover:bg-transparent" : undefined}
          >
            Disabled menu item
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  SettingsAlertRow,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Slider } from "~/components/primitives/Slider";
import { Switch } from "~/components/primitives/Switch";
import { StoryPage, StorySection } from "../storybook/StoryKit";

/* The settings-page building blocks (SettingsLayout), as used on the account
   and org settings pages, with static values. */
export default function Story_() {
  const [switchOn, setSwitchOn] = useState(true);
  const [level, setLevel] = useState("medium");
  const [contrast, setContrast] = useState(30);

  return (
    <StoryPage
      componentNames={["SettingsLayout.tsx"]}
      title="Settings rows"
      description="SettingsSection, SettingsHeader and SettingsRow — the account/org settings page pattern."
    >
      <StorySection title="A settings section">
        <div className="max-w-[37.5rem] rounded-sm border border-grid-dimmed px-4 pb-2">
          <SettingsSection>
            <SettingsHeader
              title="Appearance"
              description="How the dashboard looks for you."
              action={<Button variant="secondary/small">Reset</Button>}
            />
            <SettingsRow
              title="Receive onboarding emails"
              description="Toggle row with a switch on the right"
              htmlFor="onboarding-emails"
              action={
                <Switch
                  id="onboarding-emails"
                  variant="small"
                  checked={switchOn}
                  onCheckedChange={setSwitchOn}
                />
              }
            />
            <SettingsRow
              title="Detail level"
              description="Row with a select"
              action={
                <Select
                  aria-label="Detail level"
                  variant="secondary/small"
                  value={level}
                  setValue={(value) => setLevel(value as string)}
                  dropdownIcon
                  items={["low", "medium", "high"]}
                  text={(value) => value}
                  className="w-fit"
                >
                  {(items) =>
                    items.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))
                  }
                </Select>
              }
            />
            <SettingsRow
              title="Contrast"
              description="Row with a slider"
              action={
                <Slider
                  variant="settings"
                  className="w-44"
                  aria-label="Contrast"
                  min={0}
                  max={100}
                  step={1}
                  value={[contrast]}
                  onValueChange={([v]) => setContrast(v)}
                />
              }
            />
            <SettingsRow
              title="Small row"
              description="size='sm' tightens the rhythm"
              size="sm"
              action={<Button variant="secondary/small">Configure</Button>}
            />
            <SettingsRow title="Title-only row" bordered={false} />
          </SettingsSection>
        </div>
      </StorySection>

      <StorySection title="Alert rows" description="Severity rows with a recovery action.">
        <div className="max-w-[37.5rem] rounded-sm border border-grid-dimmed px-4">
          <SettingsAlertRow
            variant="warning"
            title="Approaching your concurrency limit"
            description="Runs may queue for longer at the current plan."
            action={<Button variant="secondary/small">Upgrade</Button>}
          />
          <SettingsAlertRow
            variant="error"
            title="Payment failed"
            description="We couldn't charge your card ending in 4242."
            action={<Button variant="danger/small">Fix billing</Button>}
          />
        </div>
      </StorySection>
    </StoryPage>
  );
}

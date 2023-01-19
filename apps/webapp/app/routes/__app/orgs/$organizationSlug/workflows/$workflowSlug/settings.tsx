import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import { Panel } from "~/components/layout/Panel";
import {
  SecondaryButton,
  DangerButton,
  PrimaryButton,
} from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";

export default function Page() {
  return (
    <>
      <Title>Settings</Title>
      <SubTitle>Workflow</SubTitle>
      <Panel className="flex items-center justify-between !p-4">
        <div className="flex gap-4 items-center">
          <ApiLogoIcon
            size="regular"
            // integration={}
          />
          <Header3 size="small" className="text-slate-300">
            Send to Slack on a new domain workflow is active.
          </Header3>
        </div>
        <div className="flex gap-2">
          <SecondaryButton>Disable</SecondaryButton>
          <DangerButton>Archive</DangerButton>
        </div>
      </Panel>
      <Panel className="flex items-center justify-between !p-4">
        <div className="flex gap-4 items-center">
          <ApiLogoIcon
            size="regular"
            // integration={}
          />
          <Header3 size="small" className="text-slate-300">
            Send to Slack on a new domain workflow is disabled.
          </Header3>
        </div>
        <div className="flex gap-2">
          <SecondaryButton>Enable</SecondaryButton>
          <DangerButton>Archive</DangerButton>
        </div>
      </Panel>
      <Panel className="flex items-center justify-between !p-4">
        <div className="flex gap-4 items-center">
          <ApiLogoIcon
            size="regular"
            // integration={}
          />
          <Header3 size="small" className="text-rose-500">
            Send to Slack on a new domain workflow is archived.
          </Header3>
        </div>
        <div className="flex gap-2">
          <PrimaryButton>Unarchive</PrimaryButton>
        </div>
      </Panel>
    </>
  );
}

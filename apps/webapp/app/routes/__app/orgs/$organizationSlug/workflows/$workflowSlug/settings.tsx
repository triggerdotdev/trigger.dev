import { ArrowsRightLeftIcon } from "@heroicons/react/24/outline";
import { Panel } from "~/components/layout/Panel";
import { SecondaryButton, DangerButton } from "~/components/primitives/Buttons";
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
          <ArrowsRightLeftIcon className="h-10 w-10 p-2 rounded bg-slate-850 text-slate-400" />
          <Header3 size="small" className="text-slate-300">
            send-to-slack-on-new-domain is disabled
          </Header3>
        </div>
        <div className="flex gap-2">
          <SecondaryButton>Disable</SecondaryButton>
          <DangerButton>Archive</DangerButton>
        </div>
      </Panel>
    </>
  );
}

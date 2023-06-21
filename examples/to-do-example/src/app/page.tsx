import { TriggerCard, TriggerSyncCard } from "./components/Cards";
import { Header1, Header2 } from "./components/Header";
import { Paragraph } from "./components/Paragraph";
import { PrimaryGradientText } from "./components/TextStyling";
import { ToDoRow } from "./components/ToDoRow";

export default function Home() {
  return (
    <main className="grid grid-cols-3 h-screen bg-midnight-950">
      <div className="flex flex-col pt-40 h-full px-12">
        <Header2 variant="small/semibold">To-do list example project</Header2>
        <div className="pb-2 flex">
          <Paragraph variant="small/medium" className="text-slate-500">
            Powered by
          </Paragraph>
        </div>
        <Paragraph variant="base">
          This project demonstrates some of the key features of Trigger.dev.{" "}
        </Paragraph>
        <div className="h-px bg-slate-800 rounded-full w-full" />
        <div className="flex flex-col pt-8 gap-y-2">
          <Paragraph variant="base" removeBottomPadding>
            <a
              rel="noopener noreferrer"
              target="_blank"
              href="https://github.com/trigger.dev/to-do-list-example"
              className="text-indigo-400 hover:underline hover:underline-offset-2 transition"
            >
              trigger.dev/to-do-list-example
            </a>
          </Paragraph>
          <Paragraph variant="base" removeBottomPadding>
            View the{" "}
            <a
              rel="noopener noreferrer"
              target="_blank"
              href=""
              className="text-indigo-400 hover:underline hover:underline-offset-2 transition"
            >
              source code
            </a>
            .
          </Paragraph>
          <Paragraph variant="base" removeBottomPadding>
            View the{" "}
            <a
              rel="noopener noreferrer"
              target="_blank"
              href=""
              className="text-indigo-400 hover:underline hover:underline-offset-2 transition"
            >
              docs
            </a>
            .
          </Paragraph>
        </div>
      </div>
      <div className="h-full w-full items-center pt-40 flex flex-col px-2">
        <Header1 variant="base/bold" className="mb-6">
          <PrimaryGradientText>To-do list</PrimaryGradientText>
        </Header1>
        <div className="flex flex-col w-full gap-y-4">
          <ToDoRow variant="add" />
          <ToDoRow variant="active" />
          <ToDoRow variant="completed" />
        </div>
      </div>
      <div className="h-full w-full pt-40 flex flex-col px-8 gap-4">
        <Paragraph variant="small" capitalize removeBottomPadding>
          Trigger.dev jobs
        </Paragraph>
        <div className="flex w-full justify-center items-center">
          <div className="rounded full h-1 w-1 bg-red-500" />
          <Paragraph
            variant="extraSmall"
            removeBottomPadding
            className="px-2"
            capitalize
          >
            Inactive
          </Paragraph>
          <div className="rounded-full h-px w-full bg-slate-800" />
        </div>
        <TriggerCard
          active={true}
          accordianContentVariant={"summaryEmailCard"}
          scheduledTime={"2.30am"}
        >
          Stuff goes here
        </TriggerCard>
        <TriggerCard
          active={false}
          accordianContentVariant="dailySlackSummary"
          scheduledTime={""}
        >
          Stuff goes here
        </TriggerCard>
        <TriggerCard
          active={false}
          accordianContentVariant="githubIssuesSync"
          scheduledTime={""}
        >
          Stuff goes here
        </TriggerCard>
        <TriggerSyncCard
          active={false}
          scheduledTime={""}
          syncCardVariant={"linearSyncVariant"}
        ></TriggerSyncCard>
      </div>
    </main>
  );
}

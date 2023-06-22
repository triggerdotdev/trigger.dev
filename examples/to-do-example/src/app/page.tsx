import { BookOpenIcon, CheckCircleIcon } from "@heroicons/react/24/solid";
import { GitHubLightIcon, SlackIcon } from "@trigger.dev/companyicons";
import { TriggerCard, TriggerSyncCard } from "./components/Cards";
import { Header1, Header2 } from "./components/Header";
import { Login } from "./components/Login";
import { Paragraph } from "./components/Paragraph";
import { PrimaryGradientText } from "./components/TextStyling";
import { ToDoRow } from "./components/ToDoRow";
import { TriggerDotDevLogo } from "./components/TriggerDotDevLogo";
import { DatePicker } from "./components/ui/datepicker";
import { Button } from "./components/Button";
// import { ToDoRow } from "./components/ToDoRow";

export default function Home() {
  return (
    <main className="grid grid-cols-1 lg:grid-cols-3 md:h-screen bg-midnight-950">
      <div className="absolute bg-gradient-radial from-indigo-900/30 to-indigo-900/0 h-2/3 w-full top-0 -z-10" />
      <div className="flex flex-col pt-40 h-full px-12">
        <Header2 variant="small/semibold">To-do list example project</Header2>
        <div className="pb-2 items-center gap-x-2 flex">
          <Paragraph
            variant="small"
            className="text-slate-500"
            removeBottomPadding
          >
            Powered by
          </Paragraph>
          <a
            href="https://trigger.dev"
            target="_blank"
            rel="noreferrer"
            className="cursor-pointer"
          >
            <TriggerDotDevLogo className="h-5" />
          </a>
        </div>
        <Paragraph variant="base">
          This project demonstrates some of the key features of Trigger.dev.{" "}
        </Paragraph>
        <div className="h-px bg-slate-800 rounded-full w-full" />
        <div className="flex flex-col pt-6 gap-y-2">
          <div className="flex gap-x-2 items-center">
            <GitHubLightIcon className="text-slate-200 w-4 h-4" />
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
          </div>
          <div className="flex gap-x-2 items-center">
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
          </div>
          <div className="flex gap-x-2 items-center">
            <BookOpenIcon className="text-slate-200 w-4 h-4" />
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
      </div>
      <div className="h-full w-full items-center pt-40 flex flex-col px-2">
        <div className="flex items-center gap-x-4 mb-6">
          <Header1 variant="base/bold" removeBottomPadding>
            <PrimaryGradientText>To-do list</PrimaryGradientText>
          </Header1>
          <div className="border border-toxic-500 rounded-md p-2 bg-gradient-primary w-12 h-12">
            <CheckCircleIcon className="text-toxic-500" />
          </div>
        </div>
        <div className="flex flex-col w-full gap-y-4">
          <ToDoRow variant="add" />
          <ToDoRow variant="active" />
          <ToDoRow variant="completed" />
        </div>
      </div>
      <div className="h-full w-full pt-40 ">
        <div className="flex flex-col place-content-between px-12 h-full pb-12">
          <div className="flex flex-col gap-4">
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
              <div className="rounded-full h-px w-full bg-slate-700 mb-4" />
              <Paragraph
                variant="extraSmall"
                className="text-slate-200 pb-2"
                removeBottomPadding
              >
                Email
              </Paragraph>
              <Paragraph variant="extraSmall" className="text-slate-400">
                Enter your email address.
              </Paragraph>
              <Paragraph
                variant="extraSmall"
                className="text-slate-200 pb-2"
                removeBottomPadding
              >
                Pick a time
              </Paragraph>

              <Paragraph variant="extraSmall" className="text-slate-400">
                Pick a time/day you’d like to receive the summary email
              </Paragraph>
              <Button
                buttonText={"Submit"}
                buttonVariant={"disabled"}
                buttonSize={"small"}
              />
            </TriggerCard>
            <TriggerCard
              active={false}
              accordianContentVariant="dailySlackSummary"
              scheduledTime={""}
            >
              <div className="rounded-full h-px w-full bg-slate-700 mb-4" />
              <Paragraph
                variant="extraSmall"
                className="text-slate-200 pb-2"
                removeBottomPadding
              >
                Pick a time
              </Paragraph>
              <Paragraph variant="extraSmall" className="text-slate-400">
                Choose when you would like to receive the summary email.
              </Paragraph>
              <Paragraph
                variant="extraSmall"
                className="text-slate-200 pb-2"
                removeBottomPadding
              >
                Connect your Slack account
              </Paragraph>
              <Button
                buttonText={"Connect Slack"}
                buttonVariant={"primary"}
                buttonSize={"small"}
                iconLeft={<SlackIcon className="w-4 h-4" />}
                className="mb-3"
              />
              <Paragraph variant="extraSmall" className="text-slate-400">
                Connect Slack to send a summary to any public channel.
              </Paragraph>
            </TriggerCard>
            <TriggerCard
              active={false}
              accordianContentVariant="githubIssuesSync"
              scheduledTime={""}
            >
              <div className="rounded-full h-px w-full bg-slate-700 mb-4" />
              <Paragraph
                variant="extraSmall"
                className="text-slate-200 pb-2"
                removeBottomPadding
              >
                Connect your GitHub account
              </Paragraph>
              <Button
                buttonText={"Connect GitHub"}
                buttonVariant={"primary"}
                buttonSize={"small"}
                iconLeft={<GitHubLightIcon className="w-4 h-4" />}
                className="mb-3"
              />
              <Paragraph variant="extraSmall" className="text-slate-400">
                Connect Slack to send a summary to any public channel.
              </Paragraph>
              <Button
                buttonText={"Submit"}
                buttonVariant={"disabled"}
                buttonSize={"small"}
              />
            </TriggerCard>
            <TriggerSyncCard
              active={false}
              scheduledTime={""}
              syncCardVariant={"linearSyncVariant"}
            ></TriggerSyncCard>
          </div>
          <Login />
        </div>
      </div>
    </main>
  );
}

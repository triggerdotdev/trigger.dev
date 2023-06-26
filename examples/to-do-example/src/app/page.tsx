import { BookOpenIcon, CheckCircleIcon } from "@heroicons/react/24/solid";
import { Button } from "./components/Button";
import { TriggerCard, TriggerSyncCard } from "./components/Cards";
import { Header1, Header2 } from "./components/Header";
import { Login } from "./components/Login";
import { Paragraph } from "./components/Paragraph";
import { PrimaryGradientText } from "./components/TextStyling";
import { ToDoRow } from "./components/ToDoRow";
import { TriggerDotDevLogo } from "./components/TriggerDotDevLogo";
import {
  CodeSandboxLightIcon,
  GitHubLightIcon,
  SlackIcon,
} from "@trigger.dev/companyicons";
// import { ToDoRow } from "./components/ToDoRow";

export default function Home() {
  return (
    <main className="bg-midnight-950 grid grid-cols-1 md:h-screen lg:grid-cols-3">
      <div className="absolute top-0 -z-10 h-2/3 w-full bg-gradient-radial from-indigo-900/30 to-indigo-900/0" />
      <div className="flex h-full flex-col px-12 pt-40">
        <Header2 variant="small/semibold">To-do list example project</Header2>
        <div className="flex items-center gap-x-2 pb-2">
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
        <div className="h-px w-full rounded-full bg-slate-800" />
        <div className="flex flex-col gap-y-2 pt-6">
          <div className="flex items-center gap-x-2">
            <GitHubLightIcon className="h-4 w-4 text-slate-200" />
            <Paragraph variant="base" removeBottomPadding>
              <a
                rel="noopener noreferrer"
                target="_blank"
                href="https://github.com/trigger.dev/to-do-list-example"
                className="text-indigo-400 transition hover:underline hover:underline-offset-2"
              >
                trigger.dev/to-do-list-example
              </a>
            </Paragraph>
          </div>
          <div className="flex items-center gap-x-2">
            <CodeSandboxLightIcon />
            <Paragraph variant="base" removeBottomPadding>
              View the{" "}
              <a
                rel="noopener noreferrer"
                target="_blank"
                href=""
                className="text-indigo-400 transition hover:underline hover:underline-offset-2"
              >
                source code
              </a>
              .
            </Paragraph>
          </div>
          <div className="flex items-center gap-x-2">
            <BookOpenIcon className="h-4 w-4 text-slate-200" />
            <Paragraph variant="base" removeBottomPadding>
              View the{" "}
              <a
                rel="noopener noreferrer"
                target="_blank"
                href=""
                className="text-indigo-400 transition hover:underline hover:underline-offset-2"
              >
                docs
              </a>
              .
            </Paragraph>
          </div>
        </div>
      </div>
      <div className="flex h-full w-full flex-col items-center px-2 pt-40">
        <div className="mb-6 flex items-center gap-x-4">
          <Header1 variant="base/bold" removeBottomPadding>
            <PrimaryGradientText>To-do</PrimaryGradientText>
          </Header1>
          <div className="h-12 w-12 rounded-md bg-gradient-primary">
            <div className="m-px rounded-md bg-slate-800 p-1">
              <CheckCircleIcon className="text-toxic-500" />
            </div>
          </div>
        </div>
        <div className="flex w-full flex-col gap-y-4">
          <ToDoRow variant="add" />
          <ToDoRow variant="active" />
          <ToDoRow variant="completed" />
        </div>
      </div>
      <div className="h-full w-full pt-40 ">
        <div className="flex h-full flex-col place-content-between px-12 pb-12">
          <div className="flex flex-col gap-4">
            <Paragraph variant="small" capitalize removeBottomPadding>
              Trigger.dev jobs
            </Paragraph>
            <div className="flex w-full items-center justify-center">
              <div className="full h-1 w-1 rounded bg-red-500" />
              <Paragraph
                variant="extraSmall"
                removeBottomPadding
                className="px-2"
                capitalize
              >
                Inactive
              </Paragraph>
              <div className="h-px w-full rounded-full bg-slate-800" />
            </div>
            <TriggerCard
              active={true}
              accordianContentVariant={"summaryEmailCard"}
              scheduledTime={"2.30am"}
            >
              <div className="mb-4 h-px w-full rounded-full bg-slate-700" />
              <Paragraph
                variant="extraSmall"
                className="pb-2 text-slate-200"
                removeBottomPadding
              >
                Email
              </Paragraph>
              <Paragraph variant="extraSmall" className="text-slate-400">
                Enter your email address.
              </Paragraph>
              <Paragraph
                variant="extraSmall"
                className="pb-2 text-slate-200"
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
              <div className="mb-4 h-px w-full rounded-full bg-slate-700" />
              <Paragraph
                variant="extraSmall"
                className="pb-2 text-slate-200"
                removeBottomPadding
              >
                Pick a time
              </Paragraph>
              <Paragraph variant="extraSmall" className="text-slate-400">
                Choose when you would like to receive the summary email.
              </Paragraph>
              <Paragraph
                variant="extraSmall"
                className="pb-2 text-slate-200"
                removeBottomPadding
              >
                Connect your Slack account
              </Paragraph>
              <Button
                buttonText={"Connect Slack"}
                buttonVariant={"primary"}
                buttonSize={"small"}
                iconLeft={<SlackIcon className="h-4 w-4" />}
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
              <div className="mb-4 h-px w-full rounded-full bg-slate-700" />
              <Paragraph
                variant="extraSmall"
                className="pb-2 text-slate-200"
                removeBottomPadding
              >
                Connect your GitHub account
              </Paragraph>
              <Button
                buttonText={"Connect GitHub"}
                buttonVariant={"primary"}
                buttonSize={"small"}
                iconLeft={<GitHubLightIcon className="h-4 w-4" />}
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

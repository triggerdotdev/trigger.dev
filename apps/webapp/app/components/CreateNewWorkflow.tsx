import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import { PopupButton } from "@typeform/embed-react";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import discord from "../assets/images/discord.png";
import { Panel } from "./layout/Panel";
import { PrimaryA, SecondaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { SubTitle } from "./primitives/text/SubTitle";

export function CreateNewWorkflow() {
  return (
    <>
      <SubTitle>Create a new workflow</SubTitle>
      <div className="flex gap-2">
        <PrimaryA
          href="https://docs.trigger.dev"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          <span>Documentation</span>
        </PrimaryA>
        <SecondaryA
          href="https://docs.trigger.dev/examples/examples"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowTopRightOnSquareIcon className="w-4 h-4" />
          <span>Example Workflows</span>
        </SecondaryA>
      </div>
    </>
  );
}

export function CreateNewWorkflowNoWorkflows({
  providers,
}: {
  providers: IntegrationMetadata[];
}) {
  return (
    <>
      <Panel className="flex flex-col p-6 overflow-hidden mb-6 max-w-4xl">
        <Body className="mb-5 max-w-max px-3.5 py-2 bg-slate-700 rounded border border-slate-600">
          Trigger.dev workflows are written in your own codebase and run in your
          existing infrastructure.
        </Body>
        <Body size="small" className={allCapsTitleClasses}>
          To get started
        </Body>
        <ol className="flex flex-col gap-2 list-decimal marker:text-slate-400 ml-5 mb-5">
          <li>
            Check out the Quick Start Guide to create your first workflow in
            your code.
          </li>
          <li>
            Trigger the workflow by writing a test on the Test page. The
            workflow run will then appear on the Runs page.
          </li>
          <li>
            If you need to authenticate with an API, the Runs page will display
            a prompt to connect.
          </li>
        </ol>
        <div className="flex gap-2">
          <PrimaryA
            href="https://docs.trigger.dev/getting-started"
            target="_blank"
            rel="noreferrer"
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
            <span>Quick Start Guide</span>
          </PrimaryA>
          <SecondaryA
            href="https://docs.trigger.dev/examples/examples"
            target="_blank"
            rel="noreferrer"
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
            <span>Example workflows</span>
          </SecondaryA>
        </div>
      </Panel>
      <SubTitle>API integrations</SubTitle>
      <Panel className="mb-6 p-6 max-w-4xl">
        <Body className="mb-4 text-slate-300">
          Easily authenticate with APIs using the supported integrations below.
          If there's an integration we don't yet support,{" "}
          <PopupButton
            id="VwblgGDZ"
            className="underline opacity-80 hover:opacity-100 transition underline-offset-2"
          >
            <span>vote for it here</span>
          </PopupButton>{" "}
          and we'll add it.
        </Body>
        <div className="flex gap-2 items-center flex-wrap">
          {providers.map((provider) => (
            <ApiLogoIcon
              key={provider.slug}
              integration={provider}
              size="regular"
            />
          ))}
          <Body className="text-slate-300">+</Body>
          <Body
            size="small"
            className="uppercase text-slate-400 bg-slate-850 py-2.5 px-4 rounded tracking-wide"
          >
            Fetch
          </Body>
          <Body className="text-slate-300">&</Body>
          <Body
            size="small"
            className="uppercase text-slate-400 bg-slate-850 py-2.5 px-4 rounded tracking-wide"
          >
            Webhooks
          </Body>
        </div>
      </Panel>
      <SubTitle>Join the community</SubTitle>
      <Panel className="p-6 max-w-4xl">
        <Body className="mb-4 text-slate-300">
          To get help quickly and answers to any questions, join our Discord.
        </Body>
        <PrimaryA
          href="https://discord.gg/kA47vcd8P6"
          target="_blank"
          rel="noreferrer"
        >
          <img src={discord} alt="Discord" className="h-3.5 -ml-1" />
          <span>Join Discord</span>
        </PrimaryA>
      </Panel>
    </>
  );
}

const allCapsTitleClasses = "mb-2 uppercase tracking-wide text-slate-400";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Panel } from "./layout/Panel";
import { PrimaryA, SecondaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import { SubTitle } from "./primitives/text/SubTitle";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import { getProviders } from "@trigger.dev/providers";
import onboarding from "../assets/images/onboarding-image.png";
import discord from "../assets/images/discord.png";

export default function CreateNewWorkflow() {
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

export function CreateNewWorkflowNoWorkflows() {
  return (
    <>
      <Panel className="flex p-0 overflow-hidden">
        <div className="flex flex-col p-6 w-full xl:w-2/3 text-slate-300 ">
          <Body className="mb-5 max-w-max px-3.5 py-2 bg-slate-700 rounded border border-slate-600">
            Trigger.dev workflows are written in your own codebase and run in
            your existing infrastructure.
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
              If you need to authenticate with an API, the Runs page will
              display a prompt to connect.
            </li>
          </ol>
          <div className="flex gap-2 mb-8">
            <PrimaryA
              href="https://docs.trigger.dev"
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
          <Body size="small" className={allCapsTitleClasses}>
            API integrations
          </Body>
          <Body className="mb-4">
            Easily authenticate with APIs using the supported integrations
            below. If there's an integration we don't yet support,{" "}
            <a
              href="mailto:help@trigger.dev"
              className="underline decoration-slate-400 underline-offset-2 hover:decoration-white hover:text-white transition"
            >
              let us know
            </a>{" "}
            and we'll add it.
          </Body>
          <div className="flex gap-2 items-center mb-8">
            {getProviders(false).map((provider) => (
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
          </div>
          <Body size="small" className={allCapsTitleClasses}>
            Join the community
          </Body>
          <Body className="mb-4">
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
        </div>
        <div className="hidden xl:flex flex-col w-1/3">
          <img
            src={onboarding}
            alt="Logo"
            className="w-full h-full object-cover"
          />
        </div>
      </Panel>
    </>
  );
}

const allCapsTitleClasses = "mb-2 uppercase tracking-wide text-slate-400";

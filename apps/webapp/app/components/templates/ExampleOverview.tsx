import { XCircleIcon } from "@heroicons/react/24/solid";
import { marked } from "marked";
import { Fragment, useState } from "react";
import invariant from "tiny-invariant";
import {
  ExampleProject,
  exampleProjects,
  fromScratchProjects,
  FromScratchProjects,
} from "~/components/samples/samplesList";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import CodeBlock from "../code/CodeBlock";
import { PrimaryButton } from "../primitives/Buttons";
import { StyledDialog } from "../primitives/Dialog";
import { Body } from "../primitives/text/Body";
import { Header2 } from "../primitives/text/Headers";

const buttonStyles =
  "relative flex flex-col cursor-pointer items-center justify-start hover:bg-slate-700 px-4 shadow gap-4 rounded bg-slate-700/50 py-8 border border-slate-700 transition";

export function ExampleOverview({
  icon,
  name,
  title,
  description,
  code,
}: ExampleProject) {
  const environment = useCurrentEnvironment();
  invariant(environment, "No environment selected");
  let [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <StyledDialog.Dialog
        onClose={(e) => setIsOpen(false)}
        appear
        show={isOpen}
        as={Fragment}
      >
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <StyledDialog.Panel className="mx-auto flex max-w-3xl items-start gap-2 overflow-hidden">
              <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                <div className="flex flex-col items-center justify-between gap-4 border-b border-slate-850/80 bg-slate-700/30 px-4 py-12">
                  {icon}
                  <Header2 size="regular" className="font-semibold">
                    {name}
                  </Header2>
                </div>
                <div className="p-4">
                  <Header2 size="regular" className="font-semibold">
                    {title}
                  </Header2>
                  <Body>{description}</Body>
                  <CodeBlock code={code(environment.apiKey)} align="top" />
                  <PrimaryButton className="mt-2 w-full">
                    Use this example
                  </PrimaryButton>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="sticky top-0 text-slate-600 transition hover:text-slate-500"
              >
                <XCircleIcon className="h-10 w-10" />
              </button>
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>
      {exampleProjects.map((project) => {
        return (
          <button
            key={project.name}
            type="button"
            onClick={(e) => setIsOpen(true)}
            className={buttonStyles}
          >
            {project.icon}
            <Body>{project.name}</Body>
          </button>
        );
      })}
    </>
  );
}

export function FromScratchOverview({
  name,
  description,
  code,
  bulletPoint1,
  bulletPoint2,
  bulletPoint3,
}: FromScratchProjects) {
  const environment = useCurrentEnvironment();
  invariant(environment, "No environment selected");
  let [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <StyledDialog.Dialog
        onClose={(e) => setIsOpen(false)}
        appear
        show={isOpen}
        as={Fragment}
      >
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <StyledDialog.Panel className="mx-auto flex max-w-3xl items-start gap-2 overflow-hidden">
              <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                <div className="flex flex-col items-center justify-between gap-4 border-b border-slate-850/80 bg-slate-700/30 px-4 py-12">
                  <Header2 size="regular" className="font-semibold">
                    {name}
                  </Header2>
                </div>
                <div className="p-4">
                  <Body>{description}</Body>
                  <ul className="list-disc pl-4 text-slate-300">
                    <li>{bulletPoint1}</li>
                    <li>{bulletPoint2}</li>
                    <li>{bulletPoint3}</li>
                  </ul>
                  <CodeBlock code={code(environment.apiKey)} align="top" />
                  <PrimaryButton className="mt-2 w-full">
                    Use this example
                  </PrimaryButton>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="sticky top-0 text-slate-600 transition hover:text-slate-500"
              >
                <XCircleIcon className="h-10 w-10" />
              </button>
            </StyledDialog.Panel>
          </div>
        </div>
      </StyledDialog.Dialog>
      {fromScratchProjects.map((project) => {
        return (
          <button
            key={project.name}
            type="button"
            onClick={(e) => setIsOpen(true)}
            className={buttonStyles}
          >
            <Body>{project.name}</Body>
          </button>
        );
      })}
    </>
  );
}

import { CubeTransparentIcon } from "@heroicons/react/24/outline";
import { XCircleIcon } from "@heroicons/react/24/solid";
import React, { Fragment, useState } from "react";
import invariant from "tiny-invariant";
import {
  ExampleProject,
  exampleProjects,
  fromScratchProjects,
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
  onSelectedProject,
}: {
  onSelectedProject: (project: ExampleProject) => void;
}) {
  const environment = useCurrentEnvironment();
  invariant(environment, "No environment selected");

  const [openProject, setOpenProject] = useState<ExampleProject | null>(null);
  const isOpen = !!openProject;

  return (
    <>
      {openProject && (
        <StyledDialog.Dialog
          onClose={(e) => setOpenProject(null)}
          appear
          show={isOpen}
          as={Fragment}
        >
          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <StyledDialog.Panel className="mx-auto flex max-w-3xl items-start gap-2 overflow-hidden">
                <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-slate-800 text-left">
                  <div className="flex flex-col items-center justify-between gap-4 border-b border-slate-850/80 bg-slate-700/30 px-4 py-12">
                    {openProject.icon}
                    <Header2 size="regular" className="font-semibold">
                      {openProject.name}
                    </Header2>
                  </div>
                  <div className="p-6">
                    <Header2 size="regular" className="font-semibold">
                      {openProject.title}
                    </Header2>
                    <Body>{openProject.description}</Body>
                    <CodeBlock
                      code={openProject.code(environment.apiKey)}
                      align="top"
                    />
                    <PrimaryButton
                      className="mt-2 w-full"
                      onClick={() => {
                        setOpenProject(null);
                        onSelectedProject(openProject);
                      }}
                    >
                      Use this example
                    </PrimaryButton>
                  </div>
                </div>
                <button
                  onClick={() => setOpenProject(null)}
                  className="sticky top-0 text-slate-600 transition hover:text-slate-500"
                >
                  <XCircleIcon className="h-10 w-10" />
                </button>
              </StyledDialog.Panel>
            </div>
          </div>
        </StyledDialog.Dialog>
      )}
      <>
        {exampleProjects.map((project) => (
          <button
            key={project.name}
            type="button"
            onClick={(e) => setOpenProject(project)}
            className={buttonStyles}
          >
            {project.icon}
            <Body>{project.name}</Body>
          </button>
        ))}
      </>
    </>
  );
}

export function FromScratchOverview({
  onSelectedProject,
}: {
  onSelectedProject: (project: ExampleProject) => void;
}) {
  const environment = useCurrentEnvironment();
  invariant(environment, "No environment selected");

  const [openProject, setOpenProject] = useState<ExampleProject | null>(null);
  const isOpen = openProject !== null;

  return (
    <>
      {openProject && (
        <StyledDialog.Dialog
          onClose={(e) => setOpenProject(null)}
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
                      {openProject.name}
                    </Header2>
                  </div>
                  <div className="p-6">
                    <Body>{openProject.description}</Body>
                    {openProject.bulletPoints && (
                      <ul className="list-disc pl-4 text-slate-300">
                        {openProject.bulletPoints.map((point, i) => (
                          <li key={i}>{point}</li>
                        ))}
                      </ul>
                    )}
                    <CodeBlock
                      code={openProject.code(environment.apiKey)}
                      align="top"
                    />
                    <PrimaryButton
                      className="mt-2 w-full"
                      onClick={() => {
                        setOpenProject(null);
                        onSelectedProject(openProject);
                      }}
                    >
                      Use this example
                    </PrimaryButton>
                  </div>
                </div>
                <button
                  onClick={() => setOpenProject(null)}
                  className="sticky top-0 text-slate-600 transition hover:text-slate-500"
                >
                  <XCircleIcon className="h-10 w-10" />
                </button>
              </StyledDialog.Panel>
            </div>
          </div>
        </StyledDialog.Dialog>
      )}
      <>
        {fromScratchProjects.map((project) => (
          <React.Fragment key={project.name}>
            <button
              key={project.name}
              type="button"
              onClick={(e) => setOpenProject(project)}
              className={buttonStyles}
            >
              <Body>{project.name}</Body>
            </button>
          </React.Fragment>
        ))}
      </>
    </>
  );
}

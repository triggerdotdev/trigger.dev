import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import classNames from "classnames";
import { Dispatch, Reducer, useReducer } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import invariant from "tiny-invariant";
import CodeBlock from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { InstallPackages } from "~/components/CreateNewWorkflow";
import { Panel } from "~/components/layout/Panel";
import { BackToStep1, BackToStep2 } from "~/components/onboarding/BackToSteps";
import { onboarding } from "~/components/onboarding/classNames";
import { StepNumber } from "~/components/onboarding/StepNumber";
import {
  PrimaryButton,
  PrimaryLink,
  TertiaryButton,
} from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import {
  ExampleProject,
  exampleProjects,
} from "~/components/samples/samplesList";
import {
  ExampleOverview,
  FromScratchOverview,
} from "~/components/templates/ExampleOverview";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { getIntegrationMetadatas } from "~/models/integrations.server";
import { getWorkflowsCreatedSinceDate } from "~/models/organization.server";
import {
  commitOnboardingSession,
  getWorkflowDate,
  setWorkflowDate,
} from "~/services/onboardingSession.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const providers = getIntegrationMetadatas(false);

  const onboardingSession = await setWorkflowDate(new Date(), request);

  return typedjson(
    { providers },
    {
      headers: {
        "Set-Cookie": await commitOnboardingSession(onboardingSession),
      },
    }
  );
};

export const action = async ({ request, params }: ActionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const workflowDate = await getWorkflowDate(request);

  if (!workflowDate) {
    console.error("workflows.new action: Invalid date");
    return typedjson({ hasNewWorkflows: false, newWorkflow: undefined });
  }

  const workflows = await getWorkflowsCreatedSinceDate(
    userId,
    organizationSlug,
    workflowDate
  );

  return typedjson({
    hasNewWorkflows: workflows.length > 0,
    newWorkflow: workflows[0],
  });
};

type ExistingRepoState =
  | { step: "choose-example"; selectedProject: null }
  | {
      step: "install-packages";
      selectedProject: ExampleProject;
    }
  | { step: "copy-example-code"; selectedProject: ExampleProject }
  | { step: "import-code"; selectedProject: ExampleProject }
  | {
      step: "run-code";
      selectedProject: ExampleProject;
    }
  | { step: "done"; selectedProject: ExampleProject };

type ExistingRepoAction =
  | { type: "clear-choice" }
  | { type: "example-chosen"; payload: ExampleProject }
  | { type: "packages-installed" }
  | { type: "code-copied" }
  | { type: "code-imported" }
  | { type: "code-run" };

const reducer = (
  state: ExistingRepoState,
  action: ExistingRepoAction
): ExistingRepoState => {
  switch (action.type) {
    case "clear-choice":
      return {
        ...state,
        selectedProject: null,
        step: "choose-example",
      };
    case "example-chosen":
      return {
        selectedProject: action.payload,
        step: "install-packages",
      };
    case "packages-installed":
      if (state.step === "choose-example") {
        return state;
      }

      return {
        ...state,
        step: "copy-example-code",
      };
    case "code-copied":
      if (state.step === "choose-example") {
        return state;
      }

      return {
        ...state,
        step: "import-code",
      };
    case "code-imported":
      if (state.step === "choose-example") {
        return state;
      }

      return {
        ...state,
        step: "run-code",
      };
    case "code-run":
      if (state.step === "choose-example") {
        return state;
      }

      return {
        ...state,
        step: "done",
      };
  }
};

export default function Step3ExistingRepo1() {
  const environment = useCurrentEnvironment();
  invariant(environment, "Environment must be defined");

  const [state, dispatch] = useReducer<
    Reducer<ExistingRepoState, ExistingRepoAction>
  >(reducer, {
    step: "choose-example",
    selectedProject: null,
  });

  return (
    <>
      <div className={classNames("flex flex-col", onboarding.maxWidth)}>
        <div className="flex items-center justify-between">
          <BackToStep1 />
        </div>
        <div className="flex items-center justify-between">
          <BackToStep2 />
        </div>
        {state.step === "choose-example" ? (
          <>
            <div className="mb-6">
              <SubTitle className="flex items-center">
                <StepNumber active stepNumber="3" />
                Choose an example
              </SubTitle>
              <Panel className="px-4 py-4">
                <SubTitle>
                  Browse examples to use as a starting point. (Opens in a modal)
                </SubTitle>
                <div className="grid grid-cols-4 gap-2">
                  <ExampleOverview
                    onSelectedProject={(project) =>
                      dispatch({ payload: project, type: "example-chosen" })
                    }
                  />
                </div>
                <SubTitle className="mt-6">Or start from scratch</SubTitle>
                <div className="grid grid-cols-4 gap-2">
                  <FromScratchOverview
                    onSelectedProject={(project) =>
                      dispatch({ payload: project, type: "example-chosen" })
                    }
                  />
                </div>
              </Panel>
            </div>
          </>
        ) : state.step === "install-packages" ? (
          <>
            <ChosenExample
              project={state.selectedProject}
              dispatch={dispatch}
            />
            <div>
              <SubTitle className="flex items-center">
                <StepNumber active stepNumber="4" />
                Install the Trigger.dev packages for this example
              </SubTitle>
            </div>
            <Panel className="px-4 py-4">
              <InstallPackages packages={exampleProjects[0].requiredPackages} />
              <div className="flex w-full justify-end">
                <PrimaryButton
                  className="mt-2"
                  onClick={() => dispatch({ type: "packages-installed" })}
                >
                  Continue
                </PrimaryButton>
              </div>
            </Panel>
          </>
        ) : state.step === "copy-example-code" ? (
          <>
            <ChosenExample
              project={state.selectedProject}
              dispatch={dispatch}
            />
            <InstalledPackages
              project={state.selectedProject}
              dispatch={dispatch}
            />
            <SubTitle className="flex items-center">
              <StepNumber active stepNumber="5" />
              Copy the example code into your project
            </SubTitle>
            <Panel className="px-4 py-4">
              <Body size="regular" className="mb-2 text-slate-400">
                Your API key has already been inserted.
              </Body>
              <CodeBlock
                code={state.selectedProject.code(environment.apiKey)}
                align="top"
              />
              <div className="flex w-full justify-end">
                <PrimaryButton
                  className="mt-2"
                  onClick={() => dispatch({ type: "code-copied" })}
                >
                  Continue
                </PrimaryButton>
              </div>
            </Panel>
          </>
        ) : state.step === "import-code" ? (
          <>
            <>
              <ChosenExample
                project={state.selectedProject}
                dispatch={dispatch}
              />
              <InstalledPackages
                project={state.selectedProject}
                dispatch={dispatch}
              />
              <AddedCode dispatch={dispatch} />
              <SubTitle className="flex items-center">
                <StepNumber active stepNumber="6" />
                Import the example code to make sure it's included
              </SubTitle>
              <Panel className="px-4 py-4">
                <Body size="regular" className="mb-2 text-slate-400">
                  If you've put the code in a standalone file (e.g.
                  <span className="rounded-md bg-[#0F172A] px-2">
                    src/triggers.ts
                  </span>
                  ), then you'll need to import it into into a file that is
                  being run on your server (e.g.
                  <span className="rounded-md bg-[#0F172A] px-2">
                    src/index.ts
                  </span>
                  ). You can do that like this:
                </Body>
                <CodeBlock code={`import "./triggers";`} align="top" />
                <PrimaryButton
                  className="mt-2"
                  onClick={() => dispatch({ type: "code-imported" })}
                >
                  Continue
                </PrimaryButton>
              </Panel>
            </>
          </>
        ) : state.step === "run-code" ? (
          <>
            <ChosenExample
              project={state.selectedProject}
              dispatch={dispatch}
            />
            <InstalledPackages
              project={state.selectedProject}
              dispatch={dispatch}
            />
            <AddedCode dispatch={dispatch} />
            <CodeImported dispatch={dispatch} />
            <SubTitle className="flex items-center">
              <StepNumber active stepNumber="7" />
              Lastly, run your web server
            </SubTitle>
            <Panel className="px-4 py-4">
              <Body size="regular" className="mb-4 text-slate-400">
                Run your server as you typically do, e.g.{" "}
                <InlineCode>npm run dev</InlineCode>. This will connect your
                workflow to Trigger.dev, so we can start sending you events. You
                should see some log messages in your server console.
              </Body>

              <CheckForWorkflows />
            </Panel>
          </>
        ) : (
          <></>
        )}
      </div>
    </>
  );
}

function ChosenExample({
  project,
  dispatch,
}: {
  project: ExampleProject;
  dispatch: Dispatch<ExistingRepoAction>;
}) {
  return (
    <div className="flex items-center justify-between">
      <SubTitle className="flex items-center">
        <StepNumber complete />
        <button
          className="transition hover:text-slate-300"
          onClick={() => dispatch({ type: "clear-choice" })}
        >
          I've chosen the example: {project.name}
        </button>
      </SubTitle>
      <TertiaryButton onClick={() => dispatch({ type: "clear-choice" })}>
        Change answer
      </TertiaryButton>
    </div>
  );
}

function InstalledPackages({
  dispatch,
  project,
}: {
  dispatch: Dispatch<ExistingRepoAction>;
  project: ExampleProject;
}) {
  return (
    <div className="flex items-center justify-between">
      <SubTitle className="flex items-center">
        <StepNumber complete />
        <button
          className="transition hover:text-slate-300"
          onClick={() =>
            dispatch({
              type: "example-chosen",
              payload: project,
            })
          }
        >
          I've installed the packages
        </button>
      </SubTitle>
      <TertiaryButton
        onClick={() =>
          dispatch({
            type: "example-chosen",
            payload: project,
          })
        }
      >
        Change answer
      </TertiaryButton>
    </div>
  );
}

function CodeImported({
  dispatch,
}: {
  dispatch: Dispatch<ExistingRepoAction>;
}) {
  return (
    <div className="flex items-center justify-between">
      <SubTitle className="flex items-center">
        <StepNumber complete />
        <button
          className="transition hover:text-slate-300"
          onClick={() => dispatch({ type: "code-copied" })}
        >
          I've imported the code into my project
        </button>
      </SubTitle>
      <TertiaryButton onClick={() => dispatch({ type: "code-copied" })}>
        Change answer
      </TertiaryButton>
    </div>
  );
}

function AddedCode({ dispatch }: { dispatch: Dispatch<ExistingRepoAction> }) {
  return (
    <div className="flex items-center justify-between">
      <SubTitle className="flex items-center">
        <StepNumber complete />
        <button
          className="transition hover:text-slate-300"
          onClick={() => dispatch({ type: "packages-installed" })}
        >
          I've added the example code to my project
        </button>
      </SubTitle>
      <TertiaryButton onClick={() => dispatch({ type: "packages-installed" })}>
        Change answer
      </TertiaryButton>
    </div>
  );
}

function CheckForWorkflows() {
  const fetchWorkflowCount = useTypedFetcher<typeof action>();

  if (fetchWorkflowCount.state !== "idle") {
    return (
      <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
        <div className="flex items-center gap-2">
          <Spinner />
          <Body size="regular" className="text-slate-300">
            Waiting for your workflow to connect...
          </Body>
        </div>
        <PrimaryButton>Connecting…</PrimaryButton>
      </div>
    );
  }

  if (fetchWorkflowCount.data === undefined) {
    return (
      <fetchWorkflowCount.Form method="post">
        <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
          <div className="flex items-center gap-2">
            <Spinner />
            <Body size="regular" className="text-slate-300">
              Waiting for your workflow to connect…
            </Body>
          </div>
          <PrimaryButton type="submit">
            Check my workflow connection
          </PrimaryButton>
        </div>
      </fetchWorkflowCount.Form>
    );
  } else {
    if (fetchWorkflowCount.data.hasNewWorkflows) {
      return (
        <div>
          <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
            <div className="flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5 text-green-400" />
              <Body size="regular" className="font-semibold text-slate-300">
                Great, "{fetchWorkflowCount.data.newWorkflow?.title}" is
                connected!
              </Body>
            </div>
            <PrimaryLink
              to={`../../workflows/${fetchWorkflowCount.data.newWorkflow?.slug}`}
            >
              View workflow
            </PrimaryLink>
          </div>
        </div>
      );
    } else {
      return (
        <div className="flex items-center justify-between rounded bg-slate-850 p-3 pl-5">
          <div className="flex items-center gap-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-400" />
            <div>
              <Body size="regular" className="text-slate-300">
                It doesn't seem like your workflow has connected yet.
              </Body>
              <Body>Check your server is running and try again.</Body>
            </div>
          </div>
          <fetchWorkflowCount.Form method="post">
            <PrimaryButton type="submit">
              Check my workflow connection
            </PrimaryButton>
          </fetchWorkflowCount.Form>
        </div>
      );
    }
  }
}

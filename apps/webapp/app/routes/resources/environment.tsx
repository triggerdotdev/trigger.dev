import { Popover, Switch, Transition } from "@headlessui/react";
import { ChevronUpDownIcon, PowerIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { useFetcher } from "@remix-run/react";
import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import classNames from "classnames";
import { Fragment } from "react";
import { z } from "zod";
import { Body } from "~/components/primitives/text/Body";
import { prisma } from "~/db.server";
import { useEnvironments } from "~/hooks/useEnvironments";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { requireUserId } from "~/services/session.server";
import { DisableEventRule } from "~/services/workflows/disableEventRule.server";
import { EnableEventRule } from "~/services/workflows/enableEventRule.server";
import { titleCase } from "~/utils";
import {
  useCurrentEnvironment,
  useCurrentEventRule,
} from "../__app/orgs/$organizationSlug/__org/workflows/$workflowSlug";

const SwitchEnvironmentFormSchema = z.object({
  action: z.literal("switch"),
  environmentId: z.string(),
  workflowId: z.string(),
});

const DisableWorkflowFormSchema = z.object({
  action: z.literal("disable"),
  eventRuleId: z.string(),
});

const EnableWorkflowFormSchema = z.object({
  action: z.literal("enable"),
  eventRuleId: z.string(),
});

const FormSchema = z.discriminatedUnion("action", [
  SwitchEnvironmentFormSchema,
  DisableWorkflowFormSchema,
  EnableWorkflowFormSchema,
]);

export const action = async ({ request }: ActionArgs) => {
  const userId = await requireUserId(request);
  if (userId === null) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const rawFormData = Object.fromEntries(await request.formData());
    const formData = FormSchema.parse(rawFormData);

    switch (formData.action) {
      case "switch": {
        const { workflowId, environmentId } = formData;
        const environment = await prisma.currentEnvironment.upsert({
          where: { workflowId_userId: { workflowId, userId } },
          update: { environmentId },
          create: { environmentId, workflowId, userId },
        });

        return json(environment);
      }
      case "enable": {
        const { eventRuleId } = formData;

        const service = new EnableEventRule();

        await service.call(eventRuleId);

        return json({ enabled: true });
      }
      case "disable": {
        const { eventRuleId } = formData;

        const service = new DisableEventRule();

        await service.call(eventRuleId);

        return json({ enabled: true });
      }
    }
  } catch (error: any) {
    throw new Response(error.message, { status: 400 });
  }
};

export function EnvironmentMenu() {
  const fetcher = useFetcher();
  const environments = useEnvironments();
  const currentEnvironment = useCurrentEnvironment();
  const currentWorkflow = useCurrentWorkflow();
  if (!environments || !currentWorkflow) {
    return <></>;
  }

  return (
    <>
      <fetcher.Form
        className="w-full"
        action="/resources/environment"
        method="post"
      >
        <input type="hidden" name="action" value="switch" />
        <input type="hidden" name="workflowId" value={currentWorkflow.id} />
        <Popover className="relative">
          {({ open }) => (
            <>
              <Popover.Button
                className={classNames(
                  currentEnvironment.slug === "live"
                    ? `hover:bg-liveEnv-500/10`
                    : `hover:bg-devEnv-500/10`,
                  "flex w-full items-center justify-between gap-2 rounded py-2 pl-3 pr-2 text-base text-slate-300 transition focus:outline-none"
                )}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={classNames(
                      currentEnvironment.slug === "live"
                        ? `border-liveEnv-500`
                        : `border-devEnv-500`,
                      "grid h-[24px] w-[24px] place-items-center rounded-lg border-2"
                    )}
                  >
                    <EnvironmentIcon slug={currentEnvironment.slug} />
                  </div>
                  <span className="transition">
                    {currentEnvironment ? (
                      <span>{titleCase(currentEnvironment.slug)}</span>
                    ) : (
                      <span className="">Select environment</span>
                    )}
                  </span>
                </div>
                <ChevronUpDownIcon
                  className={`${open ? "" : ""}
                  ml-1 h-5 w-5 text-slate-300 transition duration-150 ease-in-out`}
                  aria-hidden="true"
                />
              </Popover.Button>
              <Transition
                as={Fragment}
                enter="transition ease-out duration-200"
                enterFrom="opacity-0 translate-y-1"
                enterTo="opacity-100 translate-y-0"
                leave="transition ease-in duration-150"
                leaveFrom="opacity-100 translate-y-0"
                leaveTo="opacity-0 translate-y-1"
              >
                <Popover.Panel className="absolute left-0 z-50 mt-2 w-screen min-w-[15rem] max-w-[15rem] translate-x-0 transform px-4 sm:px-0">
                  <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                    <div className="relative grid grid-cols-1 gap-y-1 bg-slate-700 py-1">
                      {environments.map((environment) => {
                        return (
                          <Popover.Button
                            key={environment.id}
                            as="button"
                            type="submit"
                            name="environmentId"
                            value={environment.id}
                            className={classNames(
                              "mx-1 flex items-center justify-between gap-1.5 rounded px-3 py-2 text-white transition hover:bg-slate-800",
                              environment.slug === currentEnvironment?.slug &&
                                "!bg-slate-800"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <EnvironmentIcon slug={environment.slug} />
                              <span className="block truncate">
                                {titleCase(environment.slug)}
                              </span>
                            </div>
                            {environment.slug === currentEnvironment?.slug && (
                              <CheckIcon className="h-5 w-5 text-blue-600" />
                            )}
                          </Popover.Button>
                        );
                      })}
                    </div>
                  </div>
                </Popover.Panel>
              </Transition>
            </>
          )}
        </Popover>
      </fetcher.Form>
    </>
  );
}

export function EnvironmentIcon({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  let color = "bg-devEnv-500";
  if (slug === "live") {
    color = "bg-liveEnv-500";
  }
  return (
    <span
      className={classNames(
        "block h-[0.35rem] w-[0.35rem] rounded-full",
        color,
        className
      )}
    />
  );
}

export function EventRuleSwitch() {
  const fetcher = useFetcher();
  const environment = useCurrentEnvironment();
  const eventRule = useCurrentEventRule();

  let isEnabled = eventRule ? eventRule.enabled : false;

  if (fetcher.submission) {
    const action = fetcher.submission.formData.get("action");

    if (action === "enable") {
      isEnabled = true;
    }
    if (action === "disable") {
      isEnabled = false;
    }
  }

  const highlightColorClass = isEnabled
    ? environment.slug === "live"
      ? "bg-liveEnv-500"
      : "bg-devEnv-500"
    : "bg-slate-800";

  const prettyEnvironmentName =
    environment.slug === "live" ? "Live" : "Development";

  const enabledName = isEnabled ? "enabled" : "disabled";

  let hoverMessage = eventRule
    ? `This workflow is ${enabledName} in the ${prettyEnvironmentName} environment.`
    : `Connect this workflow to the ${prettyEnvironmentName} environment to enable.`;

  return (
    <div className="group ">
      <div className="mb-4 flex items-center justify-between pl-3">
        <div className="flex items-center gap-2">
          <PowerIcon
            className={classNames(
              isEnabled ? "text-slate-300" : "text-slate-500",
              "h-6 w-6 transition"
            )}
          />
          <Body
            className={classNames(
              isEnabled ? "text-slate-300" : "text-slate-500",
              "transition"
            )}
          >
            Enabled in {environment.slug === "live" ? "Live" : "Dev"}
          </Body>
        </div>
        <Switch
          checked={isEnabled}
          disabled={!eventRule}
          onChange={(newIsEnabled) => {
            eventRule &&
              fetcher.submit(
                {
                  action: newIsEnabled ? "enable" : "disable",
                  eventRuleId: eventRule.id,
                },
                { method: "post", action: "/resources/environment" }
              );
          }}
          className={classNames(
            highlightColorClass,
            !eventRule && "cursor-not-allowed opacity-50",
            "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          )}
        >
          <span className="sr-only">Toggle enable in Live</span>
          <span
            className={classNames(
              isEnabled ? "translate-x-5" : "translate-x-0",
              "pointer-events-none relative inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
            )}
          >
            <span
              className={classNames(
                isEnabled
                  ? "opacity-0 duration-100 ease-out"
                  : "opacity-100 duration-200 ease-in",
                "absolute inset-0 flex h-full w-full items-center justify-center transition-opacity"
              )}
              aria-hidden="true"
            >
              <svg
                className="h-3 w-3 text-gray-400"
                fill="none"
                viewBox="0 0 12 12"
              >
                <path
                  d="M4 8l2-2m0 0l2-2M6 6L4 4m2 2l2 2"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span
              className={classNames(
                isEnabled
                  ? "opacity-100 duration-200 ease-in"
                  : "opacity-0 duration-100 ease-out",
                "absolute inset-0 flex h-full w-full items-center justify-center transition-opacity"
              )}
              aria-hidden="true"
            >
              <svg
                className={classNames(
                  "h-3 w-3",
                  environment.slug === "live"
                    ? "text-liveEnv-500"
                    : "text-devEnv-500"
                )}
                fill="currentColor"
                viewBox="0 0 12 12"
              >
                <path d="M3.707 5.293a1 1 0 00-1.414 1.414l1.414-1.414zM5 8l-.707.707a1 1 0 001.414 0L5 8zm4.707-3.293a1 1 0 00-1.414-1.414l1.414 1.414zm-7.414 2l2 2 1.414-1.414-2-2-1.414 1.414zm3.414 2l4-4-1.414-1.414-4 4 1.414 1.414z" />
              </svg>
            </span>
          </span>
        </Switch>
      </div>
      <div className="relative rounded border border-slate-800 bg-slate-900 py-2 px-3 opacity-0 transition duration-300 group-hover:opacity-100">
        <div className="absolute -top-2 right-3 h-4 w-4 rotate-45 border-t border-l border-slate-800 bg-slate-900" />
        <Body size="small" className="text-slate-500">
          {hoverMessage}
        </Body>
      </div>
    </div>
  );
}

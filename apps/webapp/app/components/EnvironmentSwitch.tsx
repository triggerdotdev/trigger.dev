import { useState } from "react";
import { Switch } from "@headlessui/react";
import { Body } from "./primitives/text/Body";
import { PowerIcon } from "@heroicons/react/24/outline";
import { useCurrentEnvironment } from "~/routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug";

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(" ");
}

export default function EnvironmentSwitch() {
  const environment = useCurrentEnvironment();
  const [enabled, setEnabled] = useState(false);

  const highlightColorClass = enabled
    ? environment.slug === "live"
      ? "bg-liveEnv-500"
      : "bg-devEnv-500"
    : "bg-slate-800";

  return (
    <div className="group ">
      <div className="mb-4 flex items-center justify-between pl-3 pr-2.5">
        <div className="flex items-center gap-2">
          <PowerIcon
            className={classNames(
              enabled ? "text-slate-300" : "text-slate-500",
              "h-6 w-6 transition"
            )}
          />
          <Body
            className={classNames(
              enabled ? "text-slate-300" : "text-slate-500",
              "transition"
            )}
          >
            Enabled in {environment.slug === "live" ? "Live" : "Dev"}
          </Body>
        </div>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          className={classNames(
            highlightColorClass,
            "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          )}
        >
          <span className="sr-only">Toggle enable in Live</span>
          <span
            className={classNames(
              enabled ? "translate-x-5" : "translate-x-0",
              "pointer-events-none relative inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
            )}
          >
            <span
              className={classNames(
                enabled
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
                enabled
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
        <div className="absolute -top-2 right-6 h-4 w-4 rotate-45 border-t border-l border-slate-800 bg-slate-900" />
        <Body size="small" className="text-slate-500">
          This Workflow is {enabled === true ? "enabled" : "disabled"} in the{" "}
          {environment.slug === "live" ? "Live" : "Development"} environment.
        </Body>
      </div>
    </div>
  );
}

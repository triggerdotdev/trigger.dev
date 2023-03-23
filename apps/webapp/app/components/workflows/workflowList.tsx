import { CloudIcon } from "@heroicons/react/20/solid";
import {
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Body } from "~/components/primitives/text/Body";
import type { WorkflowListItem } from "~/presenters/workflowsPresenter.server";
import { EnvironmentIcon } from "~/routes/resources/environment";
import { formatDateTime } from "~/utils";
import { ApiLogoIcon } from "../code/ApiLogoIcon";
import { List } from "../layout/List";
import { Header2, Header3 } from "../primitives/text/Headers";
import { runStatusLabel } from "../runs/runStatus";
import { TriggerTypeIcon } from "../triggers/TriggerIcons";

export function WorkflowList({
  workflows,
  currentOrganizationSlug,
  className,
}: {
  workflows: WorkflowListItem[];
  currentOrganizationSlug: string;
  className?: string;
}) {
  return (
    <List className={className}>
      {workflows.map((workflow) => {
        return (
          <li key={workflow.id}>
            <Link
              to={`/orgs/${currentOrganizationSlug}/workflows/${workflow.slug}`}
              className={classNames(
                "group relative block transition hover:bg-slate-850/40",
                workflow.status === "DISABLED" ? workflowDisabled : ""
              )}
            >
              {workflow.lastRun === undefined && (
                <div className="absolute top-[9px] -right-12 flex rotate-45">
                  <div className="relative -right-7 inline-block h-5 w-12 overflow-hidden">
                    <div className="absolute bottom-0 h-[28px] w-[28px] origin-bottom-left rotate-45 transform bg-green-700" />
                  </div>
                  <Body className="z-10 bg-green-700 px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-green-200">
                    New
                  </Body>
                  <div className="relative right-5 inline-block h-5 w-12 overflow-hidden">
                    <div className="absolute bottom-0 h-[28px] w-[28px] origin-bottom-left rotate-45 transform bg-green-700" />
                  </div>
                </div>
              )}

              <div className="flex flex-col flex-wrap justify-between py-4 pl-4 pr-4 lg:flex-row lg:flex-nowrap lg:items-center">
                <div className="flex flex-1 items-center justify-between">
                  <div className="relative flex items-center">
                    {workflow.status === "CREATED" && (
                      <ExclamationTriangleIcon className="absolute -top-1.5 -left-1.5 h-6 w-6 text-amber-400" />
                    )}
                    <div className="mr-4 h-20 w-20 flex-shrink-0 self-start rounded-md bg-slate-850 p-3">
                      <TriggerTypeIcon
                        type={workflow.trigger.type}
                        provider={workflow.integrations.source}
                      />
                    </div>
                    <div className="mr-1 flex flex-col gap-1 truncate">
                      <Header2
                        size="regular"
                        className="truncate text-slate-200"
                      >
                        {workflow.title}
                      </Header2>
                      <div className="flex items-center gap-2">
                        <PillLabel label={workflow.trigger.typeTitle} />
                        <Header3
                          size="extra-small"
                          className="truncate text-slate-400"
                        >
                          {workflow.trigger.title}
                        </Header3>
                      </div>
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        {workflow.trigger.properties &&
                          workflow.trigger.properties.map((property) => (
                            <WorkflowProperty
                              key={property.key}
                              label={property.key}
                              content={`${property.value}`}
                            />
                          ))}
                      </div>
                    </div>
                  </div>
                  <ChevronRightIcon
                    className="ml-5 h-5 w-5 shrink-0 text-slate-400 lg:hidden"
                    aria-hidden="true"
                  />
                </div>
                <div className="flex flex-grow items-center lg:flex-grow-0">
                  <div className="mt-2 flex w-full flex-wrap-reverse items-center justify-between gap-3 lg:mt-0 lg:justify-end">
                    <div className="flex flex-col text-left lg:text-right">
                      <Body size="extra-small" className="text-slate-500">
                        Last run: {lastRunDescription(workflow.lastRun)}
                      </Body>
                      <Body size="extra-small" className="text-slate-500">
                        {workflow.slug}
                      </Body>
                    </div>
                    <div className="flex items-center gap-2">
                      {workflow.integrations.source && (
                        <ApiLogoIcon
                          integration={workflow.integrations.source}
                          size="regular"
                        />
                      )}
                      {workflow.integrations.services.map((service) => {
                        if (service === undefined) {
                          return null;
                        }
                        return (
                          <ApiLogoIcon
                            size="regular"
                            key={service.service}
                            integration={service}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <ChevronRightIcon
                    className="ml-5 hidden h-5 w-5 shrink-0 text-slate-400 lg:block"
                    aria-hidden="true"
                  />
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </List>
  );
}

function lastRunDescription(lastRun: WorkflowListItem["lastRun"]) {
  if (lastRun === null || lastRun === undefined) {
    return "Never";
  }

  if (lastRun.status === "SUCCESS") {
    if (lastRun.finishedAt) {
      return formatDateTime(lastRun.finishedAt);
    } else {
      return "Unknown";
    }
  }

  return runStatusLabel(lastRun.status);
}

function PillLabel({ label }: { label: string }) {
  return (
    <span className="rounded bg-slate-700 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
      {label}
    </span>
  );
}

function CloudLabel({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1 rounded bg-slate-700 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
      <CloudIcon className="h-3.5 w-3.5 text-blue-500" />
      {label}
    </span>
  );
}

function WorkflowProperty({
  label,
  content,
}: {
  label: string;
  content: string;
}) {
  return (
    <div className="flex items-baseline gap-x-1">
      <Body size="extra-small" className="uppercase text-slate-500">
        {label}
      </Body>
      <Body size="small" className="truncate text-slate-400">
        {content}
      </Body>
    </div>
  );
}

const workflowDisabled = "opacity-30";

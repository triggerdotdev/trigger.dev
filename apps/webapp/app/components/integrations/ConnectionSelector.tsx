import { Popover, Transition } from "@headlessui/react";
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/24/outline";
import { useFetcher } from "@remix-run/react";
import type { ServiceMetadata } from "@trigger.dev/integration-sdk";
import classNames from "classnames";
import { Fragment } from "react";
import type { APIConnection } from "~/models/apiConnection.server";
import { BasicConnectButton } from "./ConnectButton";

type Props = {
  type: "source" | "service";
  sourceServiceId: string;
  organizationId: string;
  integration: ServiceMetadata;
  connections: Pick<APIConnection, "id" | "title">[];
  selectedConnectionId?: string;
  className?: string;
  popoverAlign: Align;
};

type Align = "left" | "right" | "center";

export function ConnectionSelector({
  type,
  sourceServiceId,
  integration,
  connections,
  selectedConnectionId,
  organizationId,
  className,
  popoverAlign = "left",
}: Props) {
  const fetcher = useFetcher();

  if (connections.length === 0) {
    return (
      <BasicConnectButton
        integration={integration}
        organizationId={organizationId}
        sourceId={type === "source" ? sourceServiceId : undefined}
        serviceId={type === "service" ? sourceServiceId : undefined}
      />
    );
  }

  const selectedConnection = connections.find(
    (c) => c.id === selectedConnectionId
  );

  return (
    <div className={`w-full max-w-max ${className}`}>
      <Popover className="relative">
        {({ open }) => (
          <>
            <Popover.Button
              className={`
          ${open ? "" : ""}
          inline-flex items-center justify-between gap-2 rounded bg-slate-700 py-2 pl-4 pr-3 text-sm text-slate-300 shadow transition hover:bg-slate-600/80 focus:outline-none`}
            >
              <span className="text-sm text-slate-200 transition">
                {selectedConnection ? (
                  <span>{selectedConnection.title}</span>
                ) : (
                  <span className="text-slate-200">
                    Select {integration.name} connection
                  </span>
                )}
              </span>
              <ChevronUpDownIcon
                className={`${open ? "" : ""}
            ml-1 h-5 w-5 text-slate-400 transition duration-150 ease-in-out`}
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
              <Popover.Panel
                className={`absolute z-10 mt-3 w-screen min-w-max max-w-xs transform sm:px-0 ${getPopoverAlignment(
                  popoverAlign
                )}`}
              >
                <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                  <div className="flex flex-col items-stretch gap-y-1 bg-slate-700 py-1 px-1">
                    {connections.map((connection) => {
                      return (
                        <fetcher.Form
                          key={connection.id}
                          action={`/resources/${
                            type === "source" ? "sources" : "services"
                          }/${sourceServiceId}`}
                          method="put"
                        >
                          <input
                            type="hidden"
                            name={"connectionId"}
                            value={connection.id}
                          />

                          <Popover.Button
                            className={classNames(
                              "flex w-full items-center justify-between gap-1.5 rounded py-2 px-3 text-white transition hover:bg-slate-800",
                              connection.id === selectedConnectionId &&
                                "!bg-slate-800"
                            )}
                            type="submit"
                          >
                            <div className="flex items-center gap-2">
                              <span className="block truncate">
                                {connection.title}
                              </span>
                            </div>
                            {connection.id === selectedConnectionId && (
                              <CheckIcon className="h-5 w-5 text-blue-600" />
                            )}
                          </Popover.Button>
                        </fetcher.Form>
                      );
                    })}
                  </div>
                </div>
              </Popover.Panel>
            </Transition>
          </>
        )}
      </Popover>
    </div>
  );
}

function getPopoverAlignment(alignment: Align) {
  switch (alignment) {
    case "right":
      return "right-0";
    case "center":
      return "left-full -translate-x-1/2";
    case "left":
    default:
      return "left-0";
  }
}

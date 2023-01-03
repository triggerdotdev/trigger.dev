import { Popover, Transition } from "@headlessui/react";
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/24/outline";
import { useFetcher } from "@remix-run/react";
import classNames from "classnames";
import type { CatalogIntegration } from "internal-catalog";
import { Fragment } from "react";
import type { APIConnection } from "~/models/apiConnection.server";
import { BasicConnectButton } from "./ConnectButton";
import { IntegrationIcon } from "./IntegrationIcon";

type Props = {
  type: "source" | "service";
  sourceServiceId: string;
  organizationId: string;
  integration: CatalogIntegration;
  connections: Pick<APIConnection, "id" | "title">[];
  selectedConnectionId?: string;
};

export function ConnectionSelector({
  type,
  sourceServiceId,
  integration,
  connections,
  selectedConnectionId,
  organizationId,
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
    <div className="w-full max-w-max">
      <Popover className="relative">
        {({ open }) => (
          <>
            <Popover.Button
              className={`
          ${open ? "" : ""}
          group inline-flex justify-between items-center rounded text-white bg-transparent pl-1 pr-2 py-1 gap-2 text-sm hover:bg-slate-800 transition focus:outline-none border border-slate-400`}
            >
              <IntegrationIcon integration={integration} />
              <span className="transition">
                {selectedConnection ? (
                  <span>{selectedConnection.title}</span>
                ) : (
                  <span className="text-slate-400">
                    Select {integration.name} connection
                  </span>
                )}
              </span>
              <ChevronUpDownIcon
                className={`${open ? "" : "text-opacity-70"}
            ml-1 h-5 w-5 transition duration-150 ease-in-out group-hover:text-opacity-80`}
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
              <Popover.Panel className="absolute left-full z-10 mt-3 w-screen min-w-max max-w-xs -translate-x-1/2 transform sm:px-0">
                <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                  <div className="flex flex-col items-stretch gap-y-1 py-1 px-1 bg-slate-700">
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
                              "flex items-center w-full justify-between gap-1.5 py-2 px-3 text-white rounded hover:bg-slate-800 transition",
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

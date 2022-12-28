import { Popover, Transition } from "@headlessui/react";
import {
  ArrowsRightLeftIcon,
  ChevronUpDownIcon,
  CheckIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { useFetcher } from "@remix-run/react";
import classNames from "classnames";
import { Fragment } from "react";
import type { APIConnection } from "~/models/apiConnection.server";
import type { Integration } from "./ConnectButton";
import { ConnectButton } from "./ConnectButton";

type Props = {
  sourceId: string;
  organizationId: string;
  integration: Integration;
  connections: Pick<APIConnection, "id" | "title">[];
  selectedConnectionId?: string;
};

export function ConnectionSelector({
  sourceId,
  integration,
  connections,
  selectedConnectionId,
  organizationId,
}: Props) {
  const fetcher = useFetcher();

  if (connections.length === 0) {
    return (
      <ConnectButton
        key={integration.key}
        integration={integration}
        organizationId={organizationId}
        sourceId={sourceId}
        className="flex rounded-md bg-slate-800 border border-rose-400 gap-3 text-sm text-slate-200 items-center hover:bg-slate-800/30 transition shadow-md disabled:opacity-50 py-1 pl-1 pr-3"
      >
        {(status) => (
          <>
            <IntegrationIcon integration={integration} />
            {status === "loading" ? (
              <span className="">Connecting…</span>
            ) : (
              <span className="text-slate-400">
                Connect to{" "}
                <span className="text-slate-200">{integration.name}</span>
              </span>
            )}
          </>
        )}
      </ConnectButton>
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
              <Popover.Panel className="absolute left-full z-10 mt-3 w-screen min-w-max max-w-xs -translate-x-1/2 transform px-4 sm:px-0">
                <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                  <div className="relative grid gap-y-1 py-1 bg-slate-700 grid-cols-1">
                    {connections.map((connection) => {
                      return (
                        <fetcher.Form
                          key={connection.id}
                          action={`/api/v1/internal/sources/${sourceId}`}
                          method="put"
                        >
                          <input
                            type="hidden"
                            name={"connectionId"}
                            value={connection.id}
                          />
                          <Popover.Button
                            className={classNames(
                              "flex items-center justify-between gap-1.5 mx-1 px-3 py-2 text-white rounded hover:bg-slate-800 transition",
                              connection.id === selectedConnectionId &&
                                "!bg-slate-800"
                            )}
                            type="submit"
                          >
                            <div className="flex items-center gap-2">
                              <ArrowsRightLeftIcon
                                className="h-5 w-5 z-100"
                                aria-hidden="true"
                              />
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

function IntegrationIcon({ integration }: { integration: Integration }) {
  return (
    <img
      src={integration.logo}
      alt={integration.name}
      className="h-8 w-8 shadow-lg group-hover:opacity-80 transition"
    />
  );
}

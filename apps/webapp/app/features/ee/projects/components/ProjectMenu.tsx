import { Popover, Transition } from "@headlessui/react";
import {
  ArrowsRightLeftIcon,
  ChevronUpDownIcon,
} from "@heroicons/react/24/outline";
import { PlusIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { Fragment } from "react";
import invariant from "tiny-invariant";
import { BreadcrumbDivider } from "~/components/navigation/NavBar";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

const dimmedClassNames = "text-slate-500";

export function ProjectMenu() {
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be set");

  return (
    <>
      <BreadcrumbDivider />
      <div className="w-full max-w-max">
        <Popover className="relative">
          {({ open }) => (
            <>
              <Popover.Button
                className={`
                ${open ? "" : ""}
                inline-flex items-center justify-between rounded bg-transparent py-2 pl-2.5 pr-2 text-sm text-white hover:bg-slate-800 focus:outline-none`}
              >
                <ArrowsRightLeftIcon
                  className={`mr-2 h-5 w-5 ${dimmedClassNames}`}
                  aria-hidden="true"
                />
                <span className="transition">
                  <span className="truncate">Select Repo</span>
                </span>
                <ChevronUpDownIcon
                  className={`${open ? "" : "text-opacity-70"}
                  ml-1 h-5 w-5 transition duration-150 ease-in-out ${dimmedClassNames}`}
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
                <Popover.Panel className="absolute left-0 z-30 mt-3 max-h-[70vh] w-screen min-w-max max-w-xs translate-x-0 transform overflow-hidden overflow-y-auto rounded-lg px-4 sm:px-0">
                  <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                    <div className="relative grid grid-cols-1 gap-y-1 bg-slate-700 py-1">
                      <Popover.Button
                        as={Link}
                        to={`/orgs/${currentOrganization.slug}/projects/new`}
                      >
                        <div className="mx-1 flex items-center gap-2 rounded py-2 pl-2.5 transition hover:bg-slate-800">
                          <PlusIcon
                            className="h-5 w-5 text-green-500"
                            aria-hidden="true"
                          />
                          <span className="text-white">New Project</span>
                        </div>
                      </Popover.Button>
                    </div>
                  </div>
                </Popover.Panel>
              </Transition>
            </>
          )}
        </Popover>
      </div>
    </>
  );
}

import { Popover, Transition } from "@headlessui/react";
import {
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
} from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Fragment } from "react";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";

const actionClassNames = "text-green-500";

export function OrganizationMenu() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined) {
    return null;
  }

  return (
    <div className="w-full max-w-max px-4">
      <Popover className="relative">
        {({ open }) => (
          <>
            <Popover.Button
              className={`
                ${open ? "" : "text-opacity-90"}
                group inline-flex min-w-[200px] justify-between items-center rounded text-slate-700 bg-white pl-2.5 pr-2 py-1 text-sm border border-slate-200 shadow-sm hover:bg-slate-50 transition focus:outline-none`}
            >
              <span className="transition">
                {currentOrganization ? (
                  <span>{currentOrganization.title}</span>
                ) : (
                  <span className={actionClassNames}>
                    Create new Organization
                  </span>
                )}
              </span>
              <ChevronDownIcon
                className={`${open ? "rotate-180" : "text-opacity-70"}
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
              <Popover.Panel className="absolute left-1/2 z-10 mt-3 w-screen min-w-max max-w-xs -translate-x-1/2 transform px-4 sm:px-0">
                <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                  <div className="relative grid py-1 bg-white grid-cols-1">
                    {organizations.map((organization) => {
                      return (
                        <Popover.Button
                          key={organization.id}
                          as={Link}
                          to={`/orgs/${organization.slug}`}
                          className={classNames(
                            "flex items-center justify-between gap-1.5 mx-1 px-3 py-2 text-slate-600 rounded hover:bg-slate-100 transition",
                            organization.slug === currentOrganization?.slug &&
                              "!bg-slate-200"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <BookmarkIcon
                              className="h-5 w-5 z-100"
                              aria-hidden="true"
                            />
                            <span className="block truncate">
                              {organization.title}
                            </span>
                          </div>
                          {organization.slug === currentOrganization?.slug && (
                            <CheckIcon className="h-5 w-5 text-blue-500" />
                          )}
                        </Popover.Button>
                      );
                    })}
                    <Popover.Button as={Link} to={`/orgs/new`}>
                      <div className="flex items-center gap-2 mx-1 mt-1 pl-1 py-2 rounded bg-white hover:bg-slate-100 transition">
                        <PlusIcon
                          className="h-5 w-5 text-green-500"
                          aria-hidden="true"
                        />
                        <span className="text-slate-600">New Organization</span>
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
  );
}

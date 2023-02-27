import { Popover, Transition } from "@headlessui/react";
import {
  BookmarkIcon,
  BuildingOffice2Icon,
  ChevronUpDownIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { CheckIcon, PlusIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Fragment } from "react";
import {
  useCurrentOrganization,
  useIsNewOrganizationPage,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { BreadcrumbDivider } from "../layout/Header";

const actionClassNames = "text-white";
const dimmedClassNames = "text-slate-500";

export function OrganizationMenu() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();
  const isNewPage = useIsNewOrganizationPage();

  if (organizations === undefined) {
    return null;
  }

  return (
    <>
      <BreadcrumbDivider />
      <div className="w-full max-w-max">
        <Popover className="relative">
          {({ open }) => (
            <>
              <Popover.Button
                className={`
                ${open ? "" : "text-opacity-90"}
                inline-flex items-center justify-between rounded bg-transparent py-2 pl-2.5 pr-2 text-sm text-white hover:bg-slate-800 focus:outline-none`}
              >
                <BuildingOffice2Icon
                  className={`mr-2 h-5 w-5 ${dimmedClassNames}`}
                  aria-hidden="true"
                />
                <span className="transition">
                  {currentOrganization ? (
                    <span className="truncate">
                      {currentOrganization.title}
                    </span>
                  ) : isNewPage ? (
                    <span className={`${actionClassNames}, "truncate"`}>
                      Create new Organization
                    </span>
                  ) : (
                    <span className="truncate">Select organization</span>
                  )}
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
                <Popover.Panel className="absolute left-0 z-30 mt-3 max-h-[70vh] w-screen min-w-max max-w-xs translate-x-0 transform px-4 sm:px-0">
                  <div className="overflow-hidden rounded-lg ring-1 ring-black ring-opacity-5">
                    <div className="relative grid grid-cols-1 gap-y-1 bg-slate-700 py-1">
                      {organizations.map((organization) => {
                        return (
                          <Popover.Button
                            key={organization.id}
                            as={Link}
                            to={`/orgs/${organization.slug}`}
                            className={classNames(
                              "mx-1 flex items-center justify-between gap-1.5 rounded px-3 py-2 text-white transition hover:bg-slate-800",
                              organization.slug === currentOrganization?.slug &&
                                "!bg-slate-800"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              {organization.title === "Personal Workspace" ? (
                                <UserIcon
                                  className="z-100 h-5 w-5 text-slate-400"
                                  aria-hidden="true"
                                />
                              ) : (
                                <BuildingOffice2Icon
                                  className="z-100 h-5 w-5 text-slate-400"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="block truncate">
                                {organization.title}
                              </span>
                            </div>
                            {organization.slug ===
                              currentOrganization?.slug && (
                              <CheckIcon className="h-5 w-5 text-blue-500" />
                            )}
                          </Popover.Button>
                        );
                      })}
                      <Popover.Button as={Link} to={`/orgs/new`}>
                        <div className="mx-1 flex items-center gap-2 rounded py-2 pl-2.5 transition hover:bg-slate-800">
                          <PlusIcon
                            className="h-5 w-5 text-green-500"
                            aria-hidden="true"
                          />
                          <span className="text-white">New Organization</span>
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

import { Menu, Transition } from "@headlessui/react";
import classnames from "classnames";
import type { User } from "~/models/user.server";
import { UserProfilePhoto } from "./UserProfilePhoto";

const userNavigation = [{ name: "Logout", href: "/logout" }];

export function UserProfileMenu({ user }: { user: User }) {
  return (
    <Menu as="div" className="relative z-50 ml-1">
      <div>
        <Menu.Button className="transitions flex max-w-xs items-center rounded-full bg-white text-sm">
          <span className="sr-only">Open user menu</span>
          <UserProfilePhoto user={user} className="h-7 w-7" />
        </Menu.Button>
      </div>
      <Transition
        enter="transition ease-out duration-100"
        enterFrom="transform opacity-0 scale-95"
        enterTo="transform opacity-100 scale-100"
        leave="transition ease-in duration-75"
        leaveFrom="transform opacity-100 scale-100"
        leaveTo="transform opacity-0 scale-95"
      >
        <Menu.Items className="absolute right-0 mt-2 w-48 origin-top-right rounded-md bg-white pb-2 pt-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
          {user.name ? (
            <h2 className="mb-2 block border-b border-slate-200 py-2 pl-5 pr-2 text-sm font-semibold text-slate-600">
              {user.name}
            </h2>
          ) : (
            <h2 className="mb-2 block border-b border-slate-200 py-2 pl-5 pr-2 text-sm font-semibold text-slate-600">
              {user.email}
            </h2>
          )}

          {userNavigation.map((item) => (
            <Menu.Item key={item.name}>
              {({ active }) => (
                <a
                  href={item.href}
                  className={classnames(
                    active ? "bg-rose-100 text-rose-700" : "",
                    "mx-2 block rounded-md p-2 pl-3 text-sm text-slate-700"
                  )}
                >
                  {item.name}
                </a>
              )}
            </Menu.Item>
          ))}
        </Menu.Items>
      </Transition>
    </Menu>
  );
}

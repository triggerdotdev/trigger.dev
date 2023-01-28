import { Menu, Transition } from "@headlessui/react";
import classnames from "classnames";
import type { User } from "~/models/user.server";
import { Body } from "./primitives/text/Body";
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
        <Menu.Items className="absolute right-0 mt-2 w-48 origin-top-right rounded-md overflow-hidden bg-slate-700 pb-1 pt-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
          {user.name ? (
            <Body
              size="small"
              className="mb-1 block border-b border-slate-800 py-2 pl-4 pr-1 font-semibold"
            >
              {user.name}
            </Body>
          ) : (
            <Body className="mb-1 block border-b border-slate-800 py-2 pl-4 pr-1 font-semibold">
              {user.email}
            </Body>
          )}

          {userNavigation.map((item) => (
            <Menu.Item key={item.name}>
              {({ active }) => (
                <a
                  href={item.href}
                  className={classnames(
                    active ? "bg-rose-200 text-rose-700" : "",
                    "mx-1 block rounded p-2 pl-3 text-sm text-slate-300"
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

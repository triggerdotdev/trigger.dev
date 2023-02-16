import { BookOpenIcon } from "@heroicons/react/24/solid";
import { Link, Outlet } from "@remix-run/react";
import { Header } from "~/components/layout/Header";

const pages = [
  {
    title: "Terms of Service",
    href: "/legal/terms",
  },
  {
    title: "Privacy Policy",
    href: "/legal/privacy",
  },
  {
    title: "Abuse",
    href: "/legal/abuse",
  },
];

export default function Legal() {
  return (
    <div className="flex h-screen flex-col overflow-auto">
      <div className="flex-shrink-0">
        <Header>Dashboard</Header>
      </div>
      <div className="flex flex-shrink flex-grow items-center justify-between bg-slate-50">
        <ul className="h-full basis-80 bg-white p-6">
          <li className="mb-6">
            <div className="flex items-center">
              <p className="mb-2 text-xl font-semibold">Legal stuff</p>
            </div>

            <ul className="flex flex-col gap-2">
              {pages.map((page) => (
                <li
                  key={page.title}
                  className="flex rounded-md bg-slate-50 p-3 transition hover:bg-slate-200"
                >
                  <Link
                    to={page.href}
                    className="group flex flex-grow items-center"
                  >
                    <BookOpenIcon className="mr-2 h-6 w-6 text-slate-500 transition group-hover:text-blue-500" />
                    <p className="text-base text-slate-700">{page.title}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        </ul>

        <div className="flex w-full items-center justify-center">
          <code className="prose max-w-none p-8">
            <Outlet />
          </code>
        </div>
      </div>
    </div>
  );
}

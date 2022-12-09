import { DocumentTextIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { useOptionalUser } from "~/hooks/useUser";
import { Logo } from "./Logo";
import { OrganizationMenu } from "./navigation/OrganizationMenu";
import { UserProfileMenu } from "./UserProfileMenu";

type HeaderProps = {
  children?: React.ReactNode;
};

export function Header({ children }: HeaderProps) {
  const user = useOptionalUser();

  return (
    <div className="flex w-full items-center border-b border-slate-200 bg-white py-1 px-2">
      <Link to="/" aria-label="Trigger">
        <Logo className="h-6" />
      </Link>

      <OrganizationMenu />

      <div className="flex flex-1 justify-center">{children}</div>

      <div className="flex items-center gap-2">
        <a
          href="https://docs.apihero.run"
          target="_blank"
          className="group flex items-center justify-center gap-1 rounded border border-slate-200 bg-white py-1 px-2 text-sm text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-blue-600"
          rel="noreferrer"
        >
          <DocumentTextIcon className="h-4 w-4 transition group-hover:text-blue-600" />
          <span>Docs</span>
        </a>
        {user ? (
          <UserProfileMenu user={user} />
        ) : (
          <Link
            to="/login"
            className="text-gray-700 transition hover:text-black"
          >
            Login
          </Link>
        )}
      </div>
    </div>
  );
}

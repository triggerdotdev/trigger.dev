import { DocumentTextIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { useOptionalUser } from "~/hooks/useUser";
import { Logo } from "../Logo";
import { OrganizationMenu } from "../navigation/OrganizationMenu";
import { SecondaryA } from "../primitives/Buttons";
import { UserProfileMenu } from "../UserProfileMenu";

type HeaderProps = {
  children?: React.ReactNode;
};

export function Header({ children }: HeaderProps) {
  const user = useOptionalUser();

  return (
    <div className="flex w-full items-center border-b border-slate-800 bg-midnight py-1 px-2">
      <Link to="/" aria-label="Trigger">
        <Logo className="h-6" />
      </Link>

      <OrganizationMenu />

      <div className="flex flex-1 justify-center">{children}</div>

      <div className="flex items-center gap-2">
        <SecondaryA href="https://docs.apihero.run" target="_blank">
          <DocumentTextIcon className="h-4 w-4" />
          Docs
        </SecondaryA>
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

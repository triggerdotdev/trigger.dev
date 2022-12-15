import {
  SquaresPlusIcon,
  Squares2X2Icon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { NavLink } from "@remix-run/react";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";

export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[300px_2fr] h-full">{children}</div>;
}

export function SideMenu() {
  const defaultStyle =
    "group flex items-center gap-2 px-3 py-3 text-base rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white";
  const activeStyle =
    "group flex items-center gap-2 px-3 py-3 text-base rounded-md transition bg-slate-900 text-white";
  const iconStyle = "h-6 w-6";
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined || currentOrganization === undefined) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-midnight border-r border-slate-800">
      <div className="flex flex-1 flex-col overflow-y-auto pb-4">
        <nav
          className="mt-2 flex-1 space-y-1 bg-midnight px-2"
          aria-label="Sidebar"
        >
          <NavLink
            to={`/orgs/${currentOrganization.slug}`}
            end
            className={({ isActive }) =>
              isActive ? activeStyle : defaultStyle
            }
          >
            <Squares2X2Icon className={iconStyle} />
            <span className="">Workflows</span>
          </NavLink>
          <NavLink
            to={`/orgs/${currentOrganization.slug}/integrations`}
            className={({ isActive }) =>
              isActive ? activeStyle : defaultStyle
            }
          >
            <SquaresPlusIcon className={iconStyle} />
            <span className="">API Integrations</span>
          </NavLink>
          <NavLink
            to={`/orgs/${currentOrganization.slug}/members`}
            className={({ isActive }) =>
              isActive ? activeStyle : defaultStyle
            }
          >
            <UsersIcon className={iconStyle} />
            <span className="">Members</span>
          </NavLink>
        </nav>
      </div>
    </div>
  );
}

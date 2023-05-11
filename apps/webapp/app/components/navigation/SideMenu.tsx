import {
  ArrowsRightLeftIcon,
  CloudIcon,
  KeyIcon,
  SquaresPlusIcon,
} from "@heroicons/react/24/outline";
import { NavLink } from "@remix-run/react";
import invariant from "tiny-invariant";
import { useEnvironments } from "~/hooks/useEnvironments";
import { useIsOrgChildPage } from "~/hooks/useIsOrgChildPage";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { Header1 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";

//todo change to the new collapsible side menu
export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full grid-cols-[16rem_auto] overflow-hidden">
      {children}
    </div>
  );
}

type SideMenuItem = {
  name: string;
  icon: React.ReactNode;
  to: string;
  end?: boolean;
};

const iconStyle = "h-6 w-6";

export function OrganizationsSideMenu() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined || currentOrganization === undefined) {
    return null;
  }

  let items: SideMenuItem[] = [
    {
      name: "Workflows",
      icon: <ArrowsRightLeftIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}`,
      end: true,
    },
    {
      name: "API Keys",
      icon: <KeyIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}/environments`,
      end: false,
    },
  ];

  if (currentOrganization.workflows.length > 0) {
    items = [
      ...items,
      {
        name: "Repositories",
        icon: <CloudIcon className={iconStyle} />,
        to: `/orgs/${currentOrganization.slug}/projects`,
        end: false,
      },
      {
        name: "API Integrations",
        icon: <SquaresPlusIcon className={iconStyle} />,
        to: `/orgs/${currentOrganization.slug}/integrations`,
        end: false,
      },
    ];
  }

  return (
    <SideMenu
      subtitle="Organization"
      title={currentOrganization.title}
      items={items}
      backPath="/"
    />
  );
}

const defaultStyle =
  "group flex items-center gap-2 px-3 py-2 text-base rounded transition text-slate-300 hover:bg-slate-850 hover:text-white";
const activeStyle =
  "group flex items-center gap-2 px-3 py-2 text-base rounded transition bg-slate-800 text-white";

function SideMenu({
  items,
  title,
  subtitle,
  children,
}: {
  title: string;
  items: SideMenuItem[];
  backPath: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be defined");

  const isOrgChildPage = useIsOrgChildPage();
  const environments = useEnvironments();
  if (environments === undefined) {
    return <></>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-r border-slate-800 bg-slate-950">
      <div className="flex flex-1 flex-col overflow-y-auto pb-4">
        <nav
          className="flex h-full flex-col justify-between space-y-1"
          aria-label="Side menu"
        >
          <div className="flex flex-col">
            {isOrgChildPage ? (
              <div className="flex h-[3.6rem] items-center border-b border-slate-800 pl-5 pr-1">
                <Header1 className="overflow-hidden text-ellipsis whitespace-nowrap text-slate-300">
                  {title}
                </Header1>
              </div>
            ) : (
              <div className="flex h-[3.6rem] items-center border-b border-slate-800 pl-5 pr-1">
                <Header1 className="overflow-hidden text-ellipsis whitespace-nowrap text-slate-300">
                  {title}
                </Header1>
              </div>
            )}
            <div className="p-2">
              <Paragraph className="mb-1 py-3 pl-1 uppercase tracking-wider text-slate-400">
                {subtitle}
              </Paragraph>
              <div className="flex flex-col gap-y-2">
                {items.map((item) => (
                  <NavLink
                    key={item.name}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      isActive ? activeStyle : defaultStyle
                    }
                  >
                    {item.icon}
                    <span>{item.name}</span>
                  </NavLink>
                ))}
              </div>
              {children}
            </div>
          </div>
        </nav>
      </div>
    </div>
  );
}

import {
  SquaresPlusIcon,
  ArrowsRightLeftIcon,
  UsersIcon,
  ForwardIcon,
  ChevronLeftIcon,
  ArrowTopRightOnSquareIcon,
  PhoneArrowUpRightIcon,
  EnvelopeIcon,
} from "@heroicons/react/24/outline";
import { Link, NavLink } from "@remix-run/react";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import { useTypedLoaderData } from "remix-typedjson";
import type { loader } from "~/routes/__app/orgs/$organizationSlug";
import { CopyTextButton } from "../CopyTextButton";

export function SideMenuContainer({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[300px_2fr] h-full">{children}</div>;
}

type SideMenuItem = {
  name: string;
  icon: React.ReactNode;
  to: string;
};

const iconStyle = "h-6 w-6";

export function OrganizationsSideMenu() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined || currentOrganization === undefined) {
    return null;
  }

  const items: SideMenuItem[] = [
    {
      name: "Workflows",
      icon: <ArrowsRightLeftIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}`,
    },
    {
      name: "API Integrations",
      icon: <SquaresPlusIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}/integrations`,
    },
    {
      name: "Members",
      icon: <UsersIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}/members`,
    },
  ];

  return <SideMenu title={currentOrganization.title} items={items} />;
}

export function WorkflowsSideMenu() {
  const currentWorkflow = useCurrentWorkflow();

  if (currentWorkflow === undefined) {
    return null;
  }

  const items: SideMenuItem[] = [
    {
      name: "Overview",
      icon: <ArrowsRightLeftIcon className={iconStyle} />,
      to: ``,
    },
    {
      name: "Runs",
      icon: <ForwardIcon className={iconStyle} />,
      to: `runs`,
    },
    {
      name: "API integrations",
      icon: <SquaresPlusIcon className={iconStyle} />,
      to: `integrations`,
    },
  ];

  return <SideMenu title={currentWorkflow.title} items={items} />;
}

const defaultStyle =
  "group flex items-center gap-2 px-3 py-3 text-base rounded transition text-slate-300 hover:bg-slate-900 hover:text-white";
const activeStyle =
  "group flex items-center gap-2 px-3 py-3 text-base rounded transition bg-slate-800 text-white";

function SideMenu({ title, items }: { title: string; items: SideMenuItem[] }) {
  // const { organization } = useTypedLoaderData<typeof loader>();

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-1000 border-r border-slate-800">
      <div className="flex flex-1 flex-col overflow-y-auto pb-4">
        <nav
          className="mt-2 flex flex-col h-full justify-between space-y-1 bg-slate-1000 px-2"
          aria-label="Sidebar"
        >
          <div>
            <div className="group flex items-center my-2 text-slate-400 rounded hover:bg-slate-900 transition divide-x divide-transparent hover:divide-slate-900">
              <Link
                to="/"
                className="px-2 py-3 hover:bg-slate-800 rounded-l transition"
              >
                <ChevronLeftIcon className="h-5 w-5 text-slate-400" />
              </Link>

              <Header1
                size="regular"
                className="pl-2 py-2 w-full text-slate-400 rounded-r hover:bg-slate-800 transition"
              >
                <Link to="">{title}</Link>
              </Header1>
            </div>

            {items.map((item) => (
              <NavLink
                key={item.name}
                to={item.to}
                end
                className={({ isActive }) =>
                  isActive ? activeStyle : defaultStyle
                }
              >
                {item.icon}
                <span>{item.name}</span>
              </NavLink>
            ))}
          </div>
          <div className="flex flex-col gap-6">
            <ul className="flex flex-col gap-2 ml-3 mr-2">
              <li>
                <Body size="extra-small" className={menuSmallTitleStyle}>
                  API Keys
                </Body>
              </li>
              {/* {organization.environments.map((environment) => {
              return (
                <li key={environment.id} className="flex justify-between w-full">
                <Body size="small" className="text-slate-400">
                  {environment.slug}: <span className="select-all">{environment.apiKey}</span>
                </Body>
                <CopyTextButton variant="text" value={environment.apiKey} />
              </li>
              );
            })} */}
              <li className="flex justify-between w-full">
                <Body size="small" className="text-slate-400">
                  Dev: <span className="select-all">Jgfisd9Kd*&jdfks</span>
                </Body>
                <CopyTextButton variant="text" value={"sdfgsdfg"} />
              </li>
              <li className="flex justify-between w-full">
                <Body size="small" className="text-slate-400">
                  Prod: <span className="select-all">Jgfisd9Kd*&jdfks</span>
                </Body>
                <CopyTextButton variant="text" value={"sdfgsdfg"} />
              </li>
            </ul>
            <ul className="flex flex-col gap-2 ml-3">
              <li>
                <Body size="extra-small" className={menuSmallTitleStyle}>
                  Help and resources
                </Body>
              </li>
              <li>
                <Link to="/" target="_blank" className={menuSmallLinkStyle}>
                  <ArrowTopRightOnSquareIcon className={menuSmallIconStyle} />
                  Documentation
                </Link>
              </li>
              <li>
                <Link to="/" target="_blank" className={menuSmallLinkStyle}>
                  <ArrowTopRightOnSquareIcon className={menuSmallIconStyle} />
                  Quick start guide
                </Link>
              </li>
              <li>
                <Link to="/" target="_blank" className={menuSmallLinkStyle}>
                  <PhoneArrowUpRightIcon className={menuSmallIconStyle} />
                  Schedule a call
                </Link>
              </li>
              <li>
                <Link to="/" target="_blank" className={menuSmallLinkStyle}>
                  <EnvelopeIcon className={menuSmallIconStyle} />
                  Contact us
                </Link>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </div>
  );
}

const menuSmallTitleStyle = "uppercase text-slate-500 tracking-wide";
const menuSmallLinkStyle =
  "flex gap-1.5 text-slate-400 hover:text-white text-sm items-center transition";
const menuSmallIconStyle = "h-4 w-4";

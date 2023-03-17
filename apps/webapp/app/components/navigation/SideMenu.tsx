import { Switch } from "@headlessui/react";
import {
  ArrowLeftOnRectangleIcon,
  ArrowsRightLeftIcon,
  BeakerIcon,
  BuildingOffice2Icon,
  CloudArrowUpIcon,
  CloudIcon,
  Cog6ToothIcon,
  ForwardIcon,
  HomeIcon,
  KeyIcon,
  PowerIcon,
  QueueListIcon,
  Squares2X2Icon,
  SquaresPlusIcon,
} from "@heroicons/react/24/outline";
import { Link, NavLink, useLocation } from "@remix-run/react";
import classNames from "classnames";
import { useState } from "react";
import invariant from "tiny-invariant";
import type { CurrentProject } from "~/features/ee/projects/routes/projects/$projectP";
import {
  useCurrentEnvironment,
  useEnvironments,
} from "~/hooks/useEnvironments";
import { useIsOrgChildPage } from "~/hooks/useIsOrgChildPage";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useOptionalUser } from "~/hooks/useUser";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { EnvironmentMenu } from "~/routes/resources/environment";
import EnvironmentSwitch from "../EnvironmentSwitch";
import { LogoIcon } from "../LogoIcon";
import { MenuTitleToolTip } from "../primitives/MenuTitleToolTip";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

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
      environmentSwitcher={false}
      environmentDisableSwitcher={false}
    />
  );
}

export function CurrentOrganizationSideMenu() {
  const user = useOptionalUser();
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined || currentOrganization === undefined) {
    return null;
  }

  return (
    <ul className="flex h-full flex-col items-center justify-start space-y-2 border-r border-slate-800 bg-slate-950">
      <NavLink
        to="/"
        className="flex min-h-[3.6rem] w-full items-center justify-center border-b border-slate-800"
      >
        <MenuTitleToolTip text="All Organizations">
          <li className="rounded p-2 transition hover:bg-slate-800">
            <LogoIcon className="h-6 w-6" />
          </li>
        </MenuTitleToolTip>
      </NavLink>
      <div className="flex h-full flex-col items-center justify-between">
        <MenuTitleToolTip text={currentOrganization.title}>
          <NavLink
            to={`/orgs/${currentOrganization.slug}`}
            className={(isActive) =>
              isActive ? activeCollapsedStyle : defaultCollapsedStyle
            }
          >
            <li>
              <BuildingOffice2Icon className="h-6 w-6 text-slate-300" />
            </li>
          </NavLink>
        </MenuTitleToolTip>
        <MenuTitleToolTip
          text={
            user
              ? `Logout ${user.displayName ? user.displayName : user.email}`
              : "Logout"
          }
        >
          <a
            href={`/logout`}
            className="mb-2 rounded p-2 transition hover:bg-slate-600/50"
          >
            <li>
              <ArrowLeftOnRectangleIcon className="h-6 w-6 text-slate-300" />
            </li>
          </a>
        </MenuTitleToolTip>
      </div>
    </ul>
  );
}

export function OrganizationSideMenuCollapsed() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined || currentOrganization === undefined) {
    return null;
  }

  return (
    <ul className="flex h-full flex-col items-center justify-start space-y-2 border-r border-slate-800 bg-slate-950">
      <NavLink
        to="/"
        className="flex h-[3.6rem] w-full items-center justify-center border-b border-slate-800"
      >
        <MenuTitleToolTip text="All Organizations">
          <li className="rounded p-2 transition hover:bg-slate-800">
            <LogoIcon className="h-6 w-6" />
          </li>
        </MenuTitleToolTip>
      </NavLink>
      <MenuTitleToolTip text="Workflows">
        <WorkflowsNavLink slug={currentOrganization.slug}>
          <li>
            <ArrowsRightLeftIcon className="h-6 w-6 text-slate-300" />
          </li>
        </WorkflowsNavLink>
      </MenuTitleToolTip>
      <MenuTitleToolTip text="Repositories">
        <NavLink
          to={`/orgs/${currentOrganization.slug}/projects`}
          className={({ isActive }) =>
            isActive ? activeCollapsedStyle : defaultCollapsedStyle
          }
        >
          <li>
            <CloudIcon className="h-6 w-6 text-slate-300" />
          </li>
        </NavLink>
      </MenuTitleToolTip>
      <MenuTitleToolTip text="API Integrations">
        <NavLink
          to={`/orgs/${currentOrganization.slug}/integrations`}
          className={({ isActive }) =>
            isActive ? activeCollapsedStyle : defaultCollapsedStyle
          }
        >
          <li>
            <SquaresPlusIcon className="h-6 w-6 text-slate-300" />
          </li>
        </NavLink>
      </MenuTitleToolTip>
    </ul>
  );
}

const defaultCollapsedStyle = "rounded p-2 transition hover:bg-slate-800";
const activeCollapsedStyle =
  "rounded p-2 transition bg-slate-800 hover:bg-slate-600/50";

export function WorkflowsSideMenu() {
  const currentWorkflow = useCurrentWorkflow();
  const organization = useCurrentOrganization();
  const environment = useCurrentEnvironment();

  if (
    currentWorkflow === undefined ||
    organization === undefined ||
    environment === undefined
  ) {
    return null;
  }

  const workflowEventRule = currentWorkflow.rules.find(
    (rule) => rule.environmentId === environment.id
  );

  let items: SideMenuItem[] = [
    {
      name: "Overview",
      icon: <HomeIcon className={iconStyle} />,
      to: ``,
      end: true,
    },
  ];

  if (workflowEventRule) {
    items = [
      ...items,
      {
        name: "Test",
        icon: <BeakerIcon className={iconStyle} />,
        to: `test`,
      },
      {
        name: "Runs",
        icon: <ForwardIcon className={iconStyle} />,
        to: `runs`,
      },
    ];
  }

  items = [
    ...items,
    {
      name: "Connected APIs",
      icon: <Squares2X2Icon className={iconStyle} />,
      to: `integrations`,
    },
    {
      name: "API Keys",
      icon: <KeyIcon className={iconStyle} />,
      to: `environments`,
    },
    {
      name: "Settings",
      icon: <Cog6ToothIcon className={iconStyle} />,
      to: `settings`,
    },
  ];

  return (
    <SideMenu
      subtitle="Workflow"
      title={currentWorkflow.title}
      items={items}
      backPath={`/orgs/${organization.slug}`}
      environmentSwitcher={true}
      environmentDisableSwitcher={true}
    />
  );
}

export function ProjectSideMenu({
  project,
  backPath,
}: {
  project: CurrentProject;
  backPath: string;
}) {
  if (!project) {
    return null;
  }

  const items: SideMenuItem[] = [
    {
      name: "Overview",
      icon: <HomeIcon className={iconStyle} />,
      to: ``,
      end: true,
    },
    {
      name: "Deploys",
      icon: <CloudArrowUpIcon className={iconStyle} />,
      to: `deploys`,
    },
    {
      name: "Logs",
      icon: <QueueListIcon className={iconStyle} />,
      to: `logs`,
    },
    {
      name: "Settings",
      icon: <Cog6ToothIcon className={iconStyle} />,
      to: `settings`,
    },
  ];

  return (
    <SideMenu
      subtitle="Repository"
      title={project.name}
      items={items}
      backPath={backPath}
      environmentSwitcher={false}
      environmentDisableSwitcher={false}
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
  environmentSwitcher,
  environmentDisableSwitcher,
}: {
  title: string;
  items: SideMenuItem[];
  backPath: string;
  subtitle: string;
  environmentSwitcher: boolean;
  environmentDisableSwitcher: boolean;
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be defined");

  const isOrgChildPage = useIsOrgChildPage();
  const environments = useEnvironments();
  const currentEnvironment = useCurrentEnvironment();
  if (environments === undefined || currentEnvironment === undefined) {
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
                <Header1
                  size="extra-small"
                  className="overflow-hidden text-ellipsis whitespace-nowrap text-slate-300"
                >
                  {title}
                </Header1>
              </div>
            ) : (
              <div className="flex h-[3.6rem] items-center border-b border-slate-800 pl-5 pr-1">
                <Header1
                  size="extra-small"
                  className="overflow-hidden text-ellipsis whitespace-nowrap text-slate-300"
                >
                  {title}
                </Header1>
              </div>
            )}
            <div className="p-2">
              <Body
                size="small"
                className="mb-1 py-3 pl-1 uppercase tracking-wider text-slate-400"
              >
                {subtitle}
              </Body>
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
              {environmentSwitcher && (
                <div className="mt-2 mb-4">
                  <Body
                    size="small"
                    className="py-3 pl-1 uppercase tracking-wider text-slate-400"
                  >
                    Environment
                  </Body>
                  <EnvironmentMenu />
                </div>
              )}
              {environmentDisableSwitcher && <EnvironmentSwitch />}
            </div>
          </div>
        </nav>
      </div>
    </div>
  );
}

function WorkflowsNavLink({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  const location = useLocation();

  const isActive =
    location.pathname === `/orgs/${slug}` ||
    location.pathname.startsWith(`/orgs/${slug}/workflows`);

  return (
    <Link
      to={`/orgs/${slug}`}
      prefetch="intent"
      className={isActive ? activeCollapsedStyle : defaultCollapsedStyle}
    >
      {children}
    </Link>
  );
}

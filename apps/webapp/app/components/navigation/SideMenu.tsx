import {
  SquaresPlusIcon,
  ArrowsRightLeftIcon,
  UsersIcon,
  ForwardIcon,
  ChevronLeftIcon,
  ArrowTopRightOnSquareIcon,
  PhoneArrowUpRightIcon,
  EnvelopeIcon,
  BeakerIcon,
  ClipboardDocumentCheckIcon,
  Squares2X2Icon,
  Cog6ToothIcon,
} from "@heroicons/react/24/outline";
import { Link, NavLink } from "@remix-run/react";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";
import invariant from "tiny-invariant";
import { CopyText } from "../CopyText";

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
      name: "Team",
      icon: <UsersIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}/members`,
    },
  ];

  return (
    <SideMenu title={currentOrganization.title} items={items} backPath="/" />
  );
}

export function WorkflowsSideMenu() {
  const currentWorkflow = useCurrentWorkflow();
  const organization = useCurrentOrganization();

  if (currentWorkflow === undefined || organization === undefined) {
    return null;
  }

  const items: SideMenuItem[] = [
    {
      name: "Overview",
      icon: <ArrowsRightLeftIcon className={iconStyle} />,
      to: ``,
    },
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
    {
      name: "Connected APIs",
      icon: <Squares2X2Icon className={iconStyle} />,
      to: `integrations`,
    },
    {
      name: "Settings",
      icon: <Cog6ToothIcon className={iconStyle} />,
      to: `settings`,
    },
  ];

  return (
    <SideMenu
      title={currentWorkflow.title}
      items={items}
      backPath={`/orgs/${organization.slug}`}
    />
  );
}

const defaultStyle =
  "group flex items-center gap-2 px-3 py-3 text-base rounded transition text-slate-300 hover:bg-slate-850 hover:text-white";
const activeStyle =
  "group flex items-center gap-2 px-3 py-3 text-base rounded transition bg-slate-800 text-white";

function SideMenu({
  title,
  items,
  backPath,
}: {
  title: string;
  items: SideMenuItem[];
  backPath: string;
}) {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization must be defined");

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-950 border-r border-slate-800">
      <div className="flex flex-1 flex-col overflow-y-auto pb-4">
        <nav
          className="mt-2 flex flex-col h-full justify-between space-y-1 px-2"
          aria-label="Sidebar"
        >
          <div>
            <div className="group flex items-center my-2 text-slate-400 rounded hover:bg-slate-950 border border-transparent hover:border-slate-800 transition divide-x divide-transparent hover:divide-slate-900">
              <Link
                to={backPath}
                className="px-2 py-3 hover:bg-slate-800 rounded-l transition"
              >
                <ChevronLeftIcon className="h-5 w-5 text-slate-400" />
              </Link>

              <Header1
                size="small"
                className="pl-2 py-2 w-full text-slate-400 rounded-r hover:bg-slate-800 transition whitespace-nowrap text-ellipsis overflow-hidden"
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
            <ul className="flex flex-col gap-6 ml-3 mr-2">
              {organization.environments.map((environment) => {
                return (
                  <li
                    key={environment.id}
                    className="flex flex-col gap-1.5 justify-between w-full"
                  >
                    <div className="flex justify-between">
                      <Body
                        size="extra-small"
                        className={`text-slate-300 overflow-hidden ${menuSmallTitleStyle}`}
                      >
                        {environment.slug} api key
                      </Body>
                      {/* <CopyTextButton
                        variant="text"
                        value={environment.apiKey}
                      /> */}
                    </div>
                    <div className="relative overflow-hidden text-sm select-all text-slate-400 p-1 pl-2 rounded-sm border border-slate-800">
                      <span className="block absolute pointer-events-none right-7 top-0 bg-gradient-to-r from-transparent to-slate-950 w-20 h-6"></span>
                      <CopyText
                        value={environment.apiKey}
                        className="group absolute flex right-0 top-0 items-center justify-center rounded-sm w-7 h-full bg-slate-950 border-l border-slate-800 hover:bg-slate-900 transition hover:cursor-pointer active:bg-green-900"
                      >
                        <ClipboardDocumentCheckIcon className="h-5 w-5 group-active:text-green-500" />
                      </CopyText>
                      {environment.apiKey}
                    </div>
                  </li>
                );
              })}
            </ul>
            <ul className="flex flex-col gap-3 ml-3">
              <li>
                <Body size="extra-small" className={menuSmallTitleStyle}>
                  Help and resources
                </Body>
              </li>
              <li>
                <a
                  href="https://docs.trigger.dev"
                  target="_blank"
                  rel="noreferrer"
                  className={menuSmallLinkStyle}
                >
                  <ArrowTopRightOnSquareIcon className={menuSmallIconStyle} />
                  Documentation
                </a>
              </li>
              <li>
                <a
                  href="https://docs.trigger.dev/getting-started"
                  rel="noreferrer"
                  target="_blank"
                  className={menuSmallLinkStyle}
                >
                  <ArrowTopRightOnSquareIcon className={menuSmallIconStyle} />
                  Quick start guide
                </a>
              </li>
              <li>
                <a
                  href="https://cal.com/team/triggerdotdev/call"
                  rel="noreferrer"
                  target="_blank"
                  className={menuSmallLinkStyle}
                >
                  <PhoneArrowUpRightIcon className={menuSmallIconStyle} />
                  Schedule a call
                </a>
              </li>
              <li>
                <a
                  href="mailto:hello@trigger.dev"
                  className={menuSmallLinkStyle}
                >
                  <EnvelopeIcon className={menuSmallIconStyle} />
                  Contact us
                </a>
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

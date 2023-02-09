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
  PlusCircleIcon,
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
  return <div className="grid h-full grid-cols-[300px_2fr]">{children}</div>;
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

  let items: SideMenuItem[] = [
    {
      name: "Workflows",
      icon: <ArrowsRightLeftIcon className={iconStyle} />,
      to: `/orgs/${currentOrganization.slug}`,
    },
  ];

  if (currentOrganization.workflows.length > 0) {
    items = [
      ...items,
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
      {
        name: "New Workflow",
        icon: <PlusCircleIcon className={iconStyle} />,
        to: `/orgs/${currentOrganization.slug}/workflows/new`,
      },
    ];
  }

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
    <div className="flex min-h-0 flex-1 flex-col border-r border-slate-800 bg-slate-950">
      <div className="flex flex-1 flex-col overflow-y-auto pb-4">
        <nav
          className="mt-2 flex h-full flex-col justify-between space-y-1 px-2"
          aria-label="Sidebar"
        >
          <div>
            <div className="group my-2 flex items-center divide-x divide-transparent rounded border border-transparent text-slate-400 transition hover:divide-slate-900 hover:border-slate-800 hover:bg-slate-950">
              <Link
                to={backPath}
                className="rounded-l px-2 py-3 transition hover:bg-slate-800"
              >
                <ChevronLeftIcon className="h-5 w-5 text-slate-400" />
              </Link>

              <Header1
                size="small"
                className="w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-r py-2 pl-2 text-slate-400 transition hover:bg-slate-800"
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
            <ul className="ml-3 mr-2 flex flex-col gap-6">
              {organization.environments.map((environment) => {
                return (
                  <li
                    key={environment.id}
                    className="flex w-full flex-col justify-between gap-1.5"
                  >
                    <div className="flex justify-between">
                      <Body
                        size="extra-small"
                        className={`overflow-hidden text-slate-300 ${menuSmallTitleStyle}`}
                      >
                        {environment.slug} api key
                      </Body>
                      {/* <CopyTextButton
                        variant="text"
                        value={environment.apiKey}
                      /> */}
                    </div>
                    <div className="relative select-all overflow-hidden rounded-sm border border-slate-800 p-1 pl-2 text-sm text-slate-400">
                      <span className="pointer-events-none absolute right-7 top-0 block h-6 w-20 bg-gradient-to-r from-transparent to-slate-950"></span>
                      <CopyText
                        value={environment.apiKey}
                        className="group absolute right-0 top-0 flex h-full w-7 items-center justify-center rounded-sm border-l border-slate-800 bg-slate-950 transition hover:cursor-pointer hover:bg-slate-900 active:bg-green-900"
                      >
                        <ClipboardDocumentCheckIcon className="h-5 w-5 group-active:text-green-500" />
                      </CopyText>
                      {environment.apiKey}
                    </div>
                  </li>
                );
              })}
            </ul>
            <ul className="ml-3 flex flex-col gap-3">
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

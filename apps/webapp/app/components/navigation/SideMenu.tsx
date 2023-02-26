import { EyeIcon, EyeSlashIcon } from "@heroicons/react/20/solid";
import {
  ArrowsRightLeftIcon,
  ArrowTopRightOnSquareIcon,
  BeakerIcon,
  ChevronLeftIcon,
  Cog6ToothIcon,
  EnvelopeIcon,
  ForwardIcon,
  PhoneArrowUpRightIcon,
  PlusCircleIcon,
  Squares2X2Icon,
  SquaresPlusIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { QuestionMarkCircleIcon } from "@heroicons/react/24/solid";
import { Link, NavLink } from "@remix-run/react";
import { useState } from "react";
import invariant from "tiny-invariant";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";
import { useCurrentWorkflow } from "~/hooks/useWorkflows";
import { EnvironmentIcon } from "~/routes/resources/environment";
import { titleCase } from "~/utils";
import { CopyTextPanel } from "../CopyTextButton";
import { TertiaryA, TertiaryButton } from "../primitives/Buttons";
import { Body } from "../primitives/text/Body";
import { Header1 } from "../primitives/text/Headers";

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
      icon: <ArrowsRightLeftIcon className={iconStyle} />,
      to: ``,
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

  const [isShowingKeys, setIsShowingKeys] = useState(false);

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
            <ul className="ml-3 mr-2 flex flex-col gap-2">
              <li className="flex w-full items-center justify-between">
                <div className="flex">
                  <Body
                    size="extra-small"
                    className={`overflow-hidden text-slate-300 ${menuSmallTitleStyle}`}
                  >
                    API keys
                  </Body>
                  <TertiaryA
                    href="https://docs.trigger.dev/guides/environments"
                    target="_blank"
                    className="group mr-1.5 transition before:text-xs before:text-slate-400"
                  >
                    <QuestionMarkCircleIcon className="h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                  </TertiaryA>
                </div>

                {!isShowingKeys ? (
                  <TertiaryButton
                    onClick={() => setIsShowingKeys(true)}
                    className="group mr-1.5 transition before:text-xs before:text-slate-400 hover:before:content-['Show_keys']"
                  >
                    <EyeIcon className="h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                  </TertiaryButton>
                ) : (
                  <TertiaryButton
                    onClick={() => setIsShowingKeys(false)}
                    className="group mr-1.5 transition before:text-xs before:text-slate-400 hover:before:content-['Hide_keys']"
                  >
                    <EyeSlashIcon className="h-4 w-4 text-slate-500 transition group-hover:text-slate-400" />
                  </TertiaryButton>
                )}
              </li>
              {organization.environments.map((environment) => {
                return (
                  <li
                    key={environment.id}
                    className="flex w-full flex-col justify-between"
                  >
                    <div className="relative flex items-center">
                      <EnvironmentIcon
                        slug={environment.slug}
                        className="absolute top-4 left-2"
                      />
                      <CopyTextPanel
                        value={environment.apiKey}
                        text={
                          isShowingKeys
                            ? environment.apiKey
                            : `${titleCase(environment.slug)}`
                        }
                        variant="slate"
                        className="pl-6 text-slate-300 hover:text-slate-300"
                      />
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

import {
  SquaresPlusIcon,
  Squares2X2Icon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import {
  useCurrentOrganization,
  useOrganizations,
} from "~/hooks/useOrganizations";

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(" ");
}

export default function SideMenu() {
  const organizations = useOrganizations();
  const currentOrganization = useCurrentOrganization();

  if (organizations === undefined) {
    return null;
  }
  const navigation = [
    {
      name: "Workflows",
      icon: Squares2X2Icon,
      href: `/orgs/${currentOrganization ? currentOrganization.slug : ""}`,
      current: true,
    },
    {
      name: "API Integrations",
      icon: SquaresPlusIcon,
      href: `/orgs/${
        currentOrganization ? currentOrganization.slug : ""
      }/integrations`,
      current: false,
    },
    { name: "Members", icon: UsersIcon, href: "#", current: false },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-midnight border-r border-slate-800">
      <div className="flex flex-1 flex-col overflow-y-auto pb-4">
        <nav
          className="mt-2 flex-1 space-y-1 bg-midnight px-2"
          aria-label="Sidebar"
        >
          {navigation.map((item) => (
            <a
              key={item.name}
              href={item.href}
              className={classNames(
                item.current
                  ? "bg-gray-900 text-white"
                  : "text-gray-300 hover:bg-slate-800 hover:text-white",
                "group flex items-center px-3 py-3 text-base rounded-md transition"
              )}
            >
              <item.icon
                className={classNames(
                  item.current
                    ? "text-gray-300"
                    : "text-gray-400 group-hover:text-gray-300",
                  "mr-3 flex-shrink-0 h-6 w-6"
                )}
                aria-hidden="true"
              />
              <span className="flex-1">{item.name}</span>
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

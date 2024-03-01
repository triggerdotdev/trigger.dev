import { Header1 } from "~/components/primitives/Headers";
import { NamedIcon, iconNames } from "~/components/primitives/NamedIcon";
import { tablerIcons } from "~/utils/tablerIcons";

export default function Story() {
  return (
    <div className="flex flex-col gap-4 p-12">
      <div>
        <Header1 spacing>Internal</Header1>
        <div className="grid grid-cols-8 gap-4">
          {iconNames
            .sort((a, b) => a.localeCompare(b))
            .map((iconName) => (
              <div key={iconName} className="flex items-center gap-2">
                <div>
                  <NamedIcon name={iconName} className={"h-6 w-6"} />
                </div>
                <span className="text-xs text-text-dimmed">{iconName}</span>
              </div>
            ))}
        </div>
      </div>
      <div>
        <Header1 spacing>Tabler</Header1>
        <div className="grid grid-cols-8 gap-4">
          {Array.from(tablerIcons).map((iconName) => (
            <div key={iconName} className="flex items-center gap-2">
              <div>
                <NamedIcon name={iconName} className={"h-6 w-6 text-indigo-500"} />
              </div>
              <span className="text-xs text-text-dimmed">{iconName}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

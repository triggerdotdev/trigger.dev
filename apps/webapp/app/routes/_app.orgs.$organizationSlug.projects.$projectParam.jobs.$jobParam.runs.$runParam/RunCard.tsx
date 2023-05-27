import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

type RunPanelProps = {
  selected: boolean;
  children: React.ReactNode;
  onClick?: () => void;
};

export function RunPanel({ selected, children, onClick }: RunPanelProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-slate-900 transition duration-150",
        selected ? "border-green-500" : "border-slate-850",
        onClick && "cursor-pointer",
        onClick && !selected && "hover:border-green-500/30"
      )}
      onClick={() => onClick && onClick()}
    >
      {children}
    </div>
  );
}

type RunPanelHeaderProps = {
  icon: React.ReactNode;
  title: string;
  accessory?: React.ReactNode;
};

export function RunPanelHeader({
  icon,
  title,
  accessory,
}: RunPanelHeaderProps) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-slate-850 bg-slate-950 p-2">
      <div className="flex items-center gap-2">
        {typeof icon === "string" ? (
          <NamedIcon name={icon} className="h-4 w-4" />
        ) : (
          icon
        )}
        <Paragraph variant="small/bright">{title}</Paragraph>
      </div>
      <div className="flex items-center gap-2">{accessory}</div>
    </div>
  );
}

export function RunPanelBody({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

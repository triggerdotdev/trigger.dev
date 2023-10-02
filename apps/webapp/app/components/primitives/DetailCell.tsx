import { IconInBox, RenderIcon } from "./Icon";
import { Paragraph } from "./Paragraph";

type DetailCellProps = {
  leadingIcon?: RenderIcon;
  trailingIcon?: RenderIcon;
  label: string;
  description?: string;
};

export function DetailCell({ leadingIcon, trailingIcon, label, description }: DetailCellProps) {
  return (
    <div className="group flex h-11 w-full items-center gap-2 rounded-md p-1 pr-3 transition hover:bg-slate-900">
      <IconInBox icon={leadingIcon} className="flex-none transition group-hover:border-slate-750" />
      <div className="flex flex-col">
        <Paragraph
          variant="small"
          className="m-0 flex-1 text-left leading-[1.1rem] transition group-hover:text-bright"
        >
          {label}
        </Paragraph>
      </div>
      <div className="flex flex-none items-center gap-1">
        <IconInBox
          icon={trailingIcon}
          className="flex-none transition group-hover:border-slate-750"
        />
      </div>
    </div>
  );
}

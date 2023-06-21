import { ReactNode } from "react";
import { MainCenteredContainer } from "./layout/AppLayout";
import { Header1 } from "./primitives/Headers";
import { NamedIcon } from "./primitives/NamedIcon";
import { Paragraph } from "./primitives/Paragraph";

type ComingSoonProps = {
  title: string;
  description: string;
  icon: ReactNode;
};

export function ComingSoon({ title, description, icon }: ComingSoonProps) {
  return (
    <MainCenteredContainer>
      <div className="flex flex-col justify-center rounded border border-slate-800 bg-slate-850">
        <div className="mb-2 flex flex-col border-b border-slate-750 px-4 pb-3 pt-4">
          <Paragraph variant="extra-extra-small/caps">Coming soon</Paragraph>
          <div className=" flex items-center gap-1 ">
            <Header1>{title}</Header1>
            {typeof icon === "string" ? (
              <NamedIcon name={icon} className={"h-5 w-5"} />
            ) : (
              icon
            )}
          </div>
        </div>
        <Paragraph variant="small" className="p-4">
          {description}
        </Paragraph>
      </div>
    </MainCenteredContainer>
  );
}

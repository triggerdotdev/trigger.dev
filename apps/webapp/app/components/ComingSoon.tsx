import { ReactNode } from "react";
import { MainCenteredContainer } from "./layout/AppLayout";
import { Header2 } from "./primitives/Headers";
import { NamedIconInBox } from "./primitives/NamedIcon";
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
        <div className="flex items-center gap-2 border-b border-slate-750 px-4 py-4">
          {typeof icon === "string" ? (
            <NamedIconInBox
              name={icon}
              className={"h-10 w-10 bg-midnight-800"}
            />
          ) : (
            icon
          )}
          <div className="mt-0.5 flex flex-col gap-y-1">
            <Paragraph variant="extra-extra-small/caps">Coming soon</Paragraph>
            <Header2 className="-mt-0.5">{title}</Header2>
          </div>
        </div>
        <Paragraph variant="small" className="p-4">
          {description}
        </Paragraph>
      </div>
    </MainCenteredContainer>
  );
}

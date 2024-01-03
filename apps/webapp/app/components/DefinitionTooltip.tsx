import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./primitives/Tooltip";

export function DefinitionTip({
  content,
  children,
  title,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip disableHoverableContent>
        <TooltipTrigger>
          <span className="underline decoration-slate-600 decoration-dashed underline-offset-4 transition hover:decoration-slate-500">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent align="end" side="right" variant="dark" className="w-[16rem] min-w-[16rem]">
          <Header3 className="mb-1">{title}</Header3>
          {typeof content === "string" ? (
            <Paragraph variant="small">{content}</Paragraph>
          ) : (
            <div>{content}</div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

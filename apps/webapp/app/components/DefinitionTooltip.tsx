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
        <TooltipTrigger className="text-left">
          <span className="cursor-default underline decoration-charcoal-500 decoration-dashed underline-offset-4 transition hover:decoration-charcoal-400">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent align="end" side="right" className="w-[16rem] min-w-[16rem]">
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

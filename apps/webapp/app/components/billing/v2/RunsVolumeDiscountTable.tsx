import { RunPriceBracket } from "@trigger.dev/platform/v2";
import { Header2 } from "../../primitives/Headers";
import { Paragraph } from "../../primitives/Paragraph";
import { formatNumberCompact } from "~/utils/numberFormatter";

export function RunsVolumeDiscountTable({
  className,
  hideHeader = false,
  brackets,
}: {
  className?: string;
  hideHeader?: boolean;
  brackets: RunPriceBracket[];
}) {
  const runsVolumeDiscountRow =
    "flex justify-between whitespace-nowrap border-b gap-16 border-grid-bright last:pb-0 last:border-none py-2";

  const bracketData = bracketInfo(brackets);

  return (
    <div className={className}>
      {hideHeader ? null : <Header2 className="mb-2">Runs volume discount</Header2>}
      <ul>
        {bracketData.map((bracket, index) => (
          <li key={index} className={runsVolumeDiscountRow}>
            <Paragraph variant="small">{bracket.range}</Paragraph>
            <Paragraph variant="small">{bracket.costLabel}</Paragraph>
          </li>
        ))}
      </ul>
    </div>
  );
}

function bracketInfo(brackets: RunPriceBracket[]) {
  return brackets.map((bracket, index) => {
    const { upto, unitCost } = bracket;

    if (index === 0) {
      return {
        range: `First ${formatNumberCompact(upto!)}/mo`,
        costLabel: "Free",
      };
    }

    const from = brackets[index - 1].upto;
    const fromFormatted = formatNumberCompact(from!);
    const toFormatted = upto ? formatNumberCompact(upto) : undefined;

    const costLabel = `$${(unitCost * 1000).toFixed(2)}/1,000`;

    if (!upto) {
      return {
        range: `${fromFormatted} +`,
        costLabel,
      };
    }

    return {
      range: `${fromFormatted}–${toFormatted}`,
      costLabel,
    };
  });
}

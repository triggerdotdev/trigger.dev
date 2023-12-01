import { Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";

export function RunsVolumeDiscountTable({
  className,
  hideHeader = false,
}: {
  className?: string;
  hideHeader?: boolean;
}) {
  const runsVolumeDiscountRow =
    "flex justify-between whitespace-nowrap border-b gap-16 border-border last:pb-0 last:border-none py-2";
  return (
    <div className={className}>
      {hideHeader ? null : <Header2 className="mb-2">Runs volume discount</Header2>}
      <ul>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">First 10k/mo</Paragraph>
          <Paragraph variant="small">Free</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">10k–20k</Paragraph>
          <Paragraph variant="small">$1.25/1,000</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">20k–150k</Paragraph>
          <Paragraph variant="small">$0.88/1,000</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">150k–500k</Paragraph>
          <Paragraph variant="small">$0.61/1,000</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">500k–1m</Paragraph>
          <Paragraph variant="small">$0.43/1,000</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">1m–2.5m</Paragraph>
          <Paragraph variant="small">$0.30/1,000</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">2.5m–6.25m</Paragraph>
          <Paragraph variant="small">$0.21/1,000</Paragraph>
        </li>
        <li className={runsVolumeDiscountRow}>
          <Paragraph variant="small">6.25m +</Paragraph>
          <Paragraph variant="small">$0.14/1,000</Paragraph>
        </li>
      </ul>
    </div>
  );
}

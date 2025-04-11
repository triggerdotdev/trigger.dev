import { Header3 } from "../Headers";
import { Paragraph } from "../Paragraph";

export function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  <div>
    <div>
      <Header3>{title}</Header3>
      <Paragraph>{description}</Paragraph>
    </div>
    <div>{children}</div>
    <div className="flex-col items-start gap-2 text-sm">
      <div className="flex gap-2 font-medium leading-none">Trending up by 5.2% this month</div>
      <div className="text-muted-foreground leading-none">
        Showing total visitors for the last 6 months
      </div>
    </div>
  </div>;
}

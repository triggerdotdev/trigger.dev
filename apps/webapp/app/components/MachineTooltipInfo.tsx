import { MachineIcon } from "~/assets/icons/MachineIcon";
import { docsPath } from "~/utils/pathBuilder";
import { LinkButton } from "./primitives/Buttons";
import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { BookOpenIcon } from "@heroicons/react/20/solid";

export function MachineTooltipInfo() {
  return (
    <div className="flex max-w-xs flex-col gap-4 p-1">
      <div>
        <div className="mb-0.5 flex items-center gap-1.5">
          <MachineIcon preset="no-machine" />
          <Header3>No machine yet</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          The machine is set at the moment the run is dequeued.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5 flex items-center gap-1.5">
          <MachineIcon preset="micro" />
          <Header3>Micro</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          The smallest and cheapest machine available.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5 flex items-center gap-1.5">
          <MachineIcon preset="small-1x" /> <Header3>Small 1x & 2x</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Smaller machines for basic workloads. Small 1x is the default machine.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5 flex items-center gap-1.5">
          <MachineIcon preset="medium-1x" /> <Header3>Medium 1x & 2x</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Medium machines for more demanding workloads.
        </Paragraph>
      </div>
      <div>
        <div className="mb-0.5 flex items-center gap-1.5">
          <MachineIcon preset="large-1x" /> <Header3>Large 1x & 2x</Header3>
        </div>
        <Paragraph variant="small" className="text-text-dimmed">
          Larger machines for the most demanding workloads such as video processing. The larger the
          machine, the more expensive it is.
        </Paragraph>
      </div>
      <LinkButton
        to={docsPath("machines#machine-configurations")}
        variant="docs/small"
        LeadingIcon={BookOpenIcon}
      >
        Read docs
      </LinkButton>
    </div>
  );
}

import { Paragraph } from "~/components/primitives/Paragraph";
import {
  CopyableTableCell,
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type TableVariant,
} from "~/components/primitives/Table";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { StoryPage, StorySection } from "../storybook/StoryKit";

const VARIANTS: TableVariant[] = ["dimmed", "bright", "bright/no-hover", "compact/mono"];

/* Static rows — a story shouldn't generate ids at render time, which would
   differ between the server and client pass. */
const ROWS = [
  { id: "run_a1b2c3d4", task: "hello-world", status: "COMPLETED_SUCCESSFULLY" as const },
  { id: "run_e5f6g7h8", task: "send-email", status: "EXECUTING" as const },
  { id: "run_i9j0k1l2", task: "nightly-report", status: "PENDING" as const },
  { id: "run_m3n4o5p6", task: "resize-image", status: "COMPLETED_WITH_ERRORS" as const },
  { id: "run_q7r8s9t0", task: "sync-contacts", status: "CANCELED" as const },
];

function SampleTable({ variant }: { variant: TableVariant }) {
  return (
    <Table variant={variant}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run ID</TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ROWS.map((row) => (
          <TableRow key={row.id}>
            <TableCell to="#">{row.id}</TableCell>
            <TableCell to="#">{row.task}</TableCell>
            <TableCell to="#">
              <TaskRunStatusCombo status={row.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function Story_() {
  return (
    <StoryPage
      title="Tables"
      componentNames={["Table.tsx"]}
      description="All four table variants plus every cell type: links, copyable cells, chevrons, row menus and blank states."
    >
      {VARIANTS.map((variant) => (
        <StorySection key={variant} title={variant} description={`Table variant="${variant}"`}>
          <SampleTable variant={variant} />
        </StorySection>
      ))}

      <StorySection
        title="Sticky header"
        description="The header pins when a max-height is applied to the container."
      >
        <Table containerClassName="max-h-46">
          <TableHeader className="bg-background-bright">
            <TableRow>
              <TableHeaderCell>Col 1</TableHeaderCell>
              <TableHeaderCell>Col 2</TableHeaderCell>
              <TableHeaderCell>Col 3</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 10 }, (_, index) => (
              <TableRow key={index}>
                <TableCell to="#">{index + 1}</TableCell>
                <TableCell to="#">{index + 2}</TableCell>
                <TableCell to="#">{index + 3}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </StorySection>

      <StorySection
        title="Cell types"
        description="Copyable cells (hover the first column), a chevron and a row menu."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>ID (copyable)</TableHeaderCell>
              <TableHeaderCell>Task</TableHeaderCell>
              <TableHeaderCell alignment="right">Duration</TableHeaderCell>
              <TableHeaderCell hiddenLabel>Go</TableHeaderCell>
              <TableHeaderCell hiddenLabel>Menu</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((row, index) => (
              <TableRow key={row.id}>
                <CopyableTableCell value={row.id}>{row.id}</CopyableTableCell>
                <TableCell>{row.task}</TableCell>
                <TableCell alignment="right" className="tabular-nums">
                  {(index + 1) * 1.4}s
                </TableCell>
                <TableCellMenu isSticky />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </StorySection>

      <StorySection title="Blank state" description="TableBlankRow when there's nothing to show.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Run ID</TableHeaderCell>
              <TableHeaderCell>Task</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBlankRow colSpan={3}>
              <Paragraph variant="small" className="py-6 text-center">
                No runs match these filters
              </Paragraph>
            </TableBlankRow>
          </TableBody>
        </Table>
      </StorySection>
    </StoryPage>
  );
}

import { ClipboardIcon } from "@heroicons/react/24/outline";
import { IconBraces, IconFileTypeCsv } from "@tabler/icons-react";
import {
  createContext,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { cn } from "~/utils/cn";
import { AgentBlockToolsMenu } from "./AgentBlockToolsMenu";
import { copyText, type AgentBlockTool } from "./agent-block-tools";
import {
  extractMarkdownTableGrid,
  gridToCSV,
  gridToJSON,
  gridToMarkdown,
  textContent,
} from "./agent-markdown-table";
import type { HastLikeNode } from "./agent-markdown-table";

// Long values (ids, urls) truncate to one line with the full value on hover, so cells never
// wrap or squeeze the column; the horizontal scroll wrapper handles overflow instead.
const CELL_CLASS = "whitespace-nowrap align-middle py-1 font-mono text-xs leading-5";
const CELL_CONTENT_CLASS = "inline-flex max-w-[25ch] items-center gap-1 truncate leading-5";
const FULLSCREEN_CELL_CLASS = "font-mono text-xs align-middle py-1 leading-5";

// Set around the fullscreen dialog's copy of the table tree. The shared thead/tbody/tr/th/td
// overrides below read it to swap in the same Table primitives runs/tasks lists use — same
// React children, so links/code/icons inside a cell still render — instead of the compact
// card's plain, truncating markup.
const AgentTableFullscreenContext = createContext(false);

// GFM's `:---`/`---:`/`:---:` column alignment arrives as `style.textAlign` on th/td, which
// `TableHeaderCell` (unlike a plain <th>) doesn't accept as a style prop — it takes an
// `alignment` enum instead.
function alignmentFromStyle(style?: CSSProperties): "left" | "center" | "right" | undefined {
  const textAlign = style?.textAlign;
  return textAlign === "left" || textAlign === "center" || textAlign === "right"
    ? textAlign
    : undefined;
}

export function AgentMarkdownTableHead({
  node,
  ...props
}: HTMLAttributes<HTMLTableSectionElement> & { node?: HastLikeNode }) {
  if (useContext(AgentTableFullscreenContext)) {
    return <TableHeader className="bg-background-bright">{props.children}</TableHeader>;
  }
  return <thead {...props} />;
}

export function AgentMarkdownTableBody({
  node,
  ...props
}: HTMLAttributes<HTMLTableSectionElement> & { node?: HastLikeNode }) {
  if (useContext(AgentTableFullscreenContext)) {
    return <TableBody>{props.children}</TableBody>;
  }
  return <tbody {...props} />;
}

export function AgentMarkdownTableRow({
  node,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { node?: HastLikeNode }) {
  if (useContext(AgentTableFullscreenContext)) {
    return <TableRow className="after:left-0">{props.children}</TableRow>;
  }
  return <tr {...props} />;
}

export function AgentMarkdownTableCell({
  node,
  children,
  className,
  colSpan,
  style,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { node?: HastLikeNode }) {
  if (useContext(AgentTableFullscreenContext)) {
    return (
      <TableCell className={cn(className, FULLSCREEN_CELL_CLASS)} colSpan={colSpan} style={style}>
        {children}
      </TableCell>
    );
  }
  return (
    <td {...props} colSpan={colSpan} style={style} className={cn(className, CELL_CLASS)}>
      <span className={CELL_CONTENT_CLASS} title={textContent(node)}>
        {children}
      </span>
    </td>
  );
}

export function AgentMarkdownTableHeaderCell({
  node,
  children,
  className,
  colSpan,
  style,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { node?: HastLikeNode }) {
  if (useContext(AgentTableFullscreenContext)) {
    return (
      <TableHeaderCell
        className={cn(className, FULLSCREEN_CELL_CLASS)}
        colSpan={colSpan}
        alignment={alignmentFromStyle(style)}
      >
        {children}
      </TableHeaderCell>
    );
  }
  return (
    <th {...props} colSpan={colSpan} style={style} className={cn(className, CELL_CLASS)}>
      <span className={CELL_CONTENT_CLASS} title={textContent(node)}>
        {children}
      </span>
    </th>
  );
}

export function AgentMarkdownTable({
  node,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { node?: HastLikeNode }) {
  const grid = extractMarkdownTableGrid(node);
  const hasRows = grid.rows.length > 0;

  const tools: AgentBlockTool[] = [
    {
      icon: IconFileTypeCsv,
      title: "Copy CSV",
      disabled: !hasRows,
      onClick: () => copyText(gridToCSV(grid)),
    },
    {
      icon: IconBraces,
      title: "Copy JSON",
      disabled: !hasRows,
      onClick: () => copyText(gridToJSON(grid)),
    },
    {
      icon: ClipboardIcon,
      title: "Copy Markdown",
      disabled: !hasRows,
      onClick: () => copyText(gridToMarkdown(grid)),
    },
  ];

  const compactTable = <table {...props} className={cn(props.className, "min-w-full my-0!")} />;

  const fullscreenTable = (
    <AgentTableFullscreenContext.Provider value>
      <Table
        variant="dimmed/no-hover"
        stickyHeader
        showTopBorder={false}
        fullWidth
        className="my-0!"
      >
        {props.children}
      </Table>
    </AgentTableFullscreenContext.Provider>
  );

  return (
    <ChartCard
      accessory={<AgentBlockToolsMenu tools={tools} revealOnHover={false} />}
      alwaysShowControls
      className="border-border-bright bg-background-dimmed"
      contentClassName="min-h-0 flex-1"
      padded={false}
      fullscreenContentClassName="min-h-0 w-full flex-1 overflow-hidden"
      fullscreenChildren={
        <div data-agent-table className="h-full min-h-0 overflow-auto">
          {fullscreenTable}
        </div>
      }
    >
      <div data-agent-table className="overflow-x-auto">
        {compactTable}
      </div>
    </ChartCard>
  );
}

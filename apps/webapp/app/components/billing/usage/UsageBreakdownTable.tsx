import { ChevronRightIcon } from "@heroicons/react/20/solid";
import type { MachinePresetName } from "@trigger.dev/core/v3";
import { Fragment, useState, type ReactNode } from "react";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { RegionLabel } from "~/components/runs/v3/RegionLabel";
import {
  UNSPLIT_VALUE,
  type UsageDimension,
  type UsageNode,
  type UsageProject,
} from "~/utils/billingUsageBreakdown";
import {
  sharePercent,
  usageDimensionTitle,
  usageEnvironmentType,
  usageRegionLocation,
  usageTypeLabel,
} from "~/utils/billingUsageFormat";
import { cn } from "~/utils/cn";

export type UsageColumn =
  | { header: string; text: (node: UsageNode) => string | null; dimmed?: boolean }
  | { header: string; share: (node: UsageNode) => number; whole: number };

const INDENT_REM = 1.375;

export function UsageBreakdownTable({
  nodes,
  groupings,
  columns,
  projects = [],
  footer,
  emptyMessage,
}: {
  nodes: UsageNode[];
  groupings: UsageDimension[];
  columns: UsageColumn[];
  projects?: UsageProject[];
  footer?: ReactNode;
  emptyMessage: string;
}) {
  const [expanded, setExpanded] = useState(() => new Set(nodes.map((node) => node.id)));

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderRows = (rows: UsageNode[], depth: number): ReactNode =>
    rows.map((node) => {
      const isOpen = expanded.has(node.id);
      const hasChildren = node.children.length > 0;

      return (
        <Fragment key={node.id}>
          <TableRow className={cn(depth === 0 && "font-medium")}>
            <TableCell>
              <div
                className="flex items-center gap-1"
                style={{ paddingLeft: `${depth * INDENT_REM}rem` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                    onClick={() => toggle(node.id)}
                    className="flex size-5 items-center justify-center rounded-sm text-text-dimmed hover:bg-background-hover hover:text-text-bright"
                  >
                    <ChevronRightIcon className={cn("size-4 transition", isOpen && "rotate-90")} />
                  </button>
                ) : (
                  <span className="size-5" />
                )}
                <UsageDimensionLabel node={node} projects={projects} />
                {depth === 0 && hasChildren && (
                  <span className="ml-1 text-xs tabular-nums text-text-dimmed">
                    {node.children.length}
                  </span>
                )}
              </div>
            </TableCell>
            {columns.map((column, index) => (
              <TableCell key={index} alignment="right" className="tabular-nums">
                <UsageColumnValue column={column} node={node} />
              </TableCell>
            ))}
          </TableRow>
          {hasChildren && isOpen && renderRows(node.children, depth + 1)}
        </Fragment>
      );
    });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>{groupings.map(usageDimensionTitle).join(" › ")}</TableHeaderCell>
          {columns.map((column, index) => (
            <TableHeaderCell key={index} alignment="right">
              {column.header}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.length === 0 ? (
          <TableBlankRow colSpan={columns.length + 1}>
            <Paragraph className="w-auto" variant="base/bright">
              {emptyMessage}
            </Paragraph>
          </TableBlankRow>
        ) : (
          renderRows(nodes, 0)
        )}
        {footer}
      </TableBody>
    </Table>
  );
}

export function UsageFooterRow({
  label,
  cells,
  emphasis,
}: {
  label: string;
  cells: ReactNode[];
  emphasis?: boolean;
}) {
  return (
    <TableRow className={cn(emphasis && "font-medium")}>
      <TableCell className={cn(emphasis ? "text-text-bright" : "text-text-dimmed")}>
        {label}
      </TableCell>
      {cells.map((cell, index) => (
        <TableCell key={index} alignment="right" className="tabular-nums">
          {cell}
        </TableCell>
      ))}
    </TableRow>
  );
}

function UsageColumnValue({ column, node }: { column: UsageColumn; node: UsageNode }) {
  if ("share" in column) return <ShareCell part={column.share(node)} whole={column.whole} />;
  const text = column.text(node);
  if (text === null) return null;
  return <span className={cn(column.dimmed && "text-text-dimmed")}>{text}</span>;
}

function ShareCell({ part, whole }: { part: number; whole: number }) {
  const percent = sharePercent(part, whole);

  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-sm bg-background-raised">
        <div className="h-full rounded-sm bg-indigo-500" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-12 text-right text-text-dimmed">{percent.toFixed(1)}%</span>
    </div>
  );
}

function UsageDimensionLabel({ node, projects }: { node: UsageNode; projects: UsageProject[] }) {
  if (node.value === UNSPLIT_VALUE) {
    return (
      <span className="text-text-dimmed">
        Not split by {usageDimensionTitle(node.dimension).toLowerCase()}
      </span>
    );
  }

  switch (node.dimension) {
    case "usageType":
      return <span>{usageTypeLabel(node.value)}</span>;
    case "machine":
      return <MachineLabelCombo preset={node.value as MachinePresetName} />;
    case "environment": {
      const type = usageEnvironmentType(node.value);
      return type ? <EnvironmentCombo environment={{ type }} /> : <span>{node.value}</span>;
    }
    case "region":
      return (
        <RegionLabel region={{ name: node.value, location: usageRegionLocation(node.value) }} />
      );
    case "project": {
      const project = projects.find((candidate) => candidate.id === node.value);
      if (!project) return <span>{node.value}</span>;
      return (
        <span className="flex items-baseline gap-1.5">
          {project.name}
          <span className="font-mono text-xs text-text-dimmed">{project.slug}</span>
          {project.deleted && <span className="text-xs text-text-dimmed">(deleted)</span>}
        </span>
      );
    }
  }
}

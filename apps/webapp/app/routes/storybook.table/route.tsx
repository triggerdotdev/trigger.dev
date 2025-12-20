import React from "react";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  CopyableTableCell,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";

export default function Story() {
  return (
    <div className="flex flex-col gap-y-4 p-4">
      <div className="flex flex-col gap-2">
        <Header1>Static table</Header1>
        <Paragraph>This table scrolls with its parent container only.</Paragraph>

        <Table>
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
      </div>
      <div className="flex flex-col gap-2">
        <Header1>Sticky header table</Header1>
        <Paragraph>
          This table scrolls when a max-height is applied to the Table component.
        </Paragraph>
        <Table containerClassName="max-h-[11.5rem]">
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
      </div>
      <div className="flex flex-col gap-2">
        <Header1>Copyable cells</Header1>
        <Paragraph>
          Hover over the first column to see the copy button. Click to copy the cell value.
        </Paragraph>
        <Table>
          <TableHeader className="bg-background-bright">
            <TableRow>
              <TableHeaderCell>ID (copyable)</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }, (_, index) => {
              const id = `run_${crypto.randomUUID().slice(0, 8)}`;
              return (
                <TableRow key={index}>
                  <CopyableTableCell value={id}>{id}</CopyableTableCell>
                  <TableCell>Task {index + 1}</TableCell>
                  <TableCell>Completed</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// via https://github.com/maticzav/ink-table
// inlined here because of https://github.com/maticzav/ink-table/issues/258

import React from "react";
import { Box, Text } from "ink";
import { sha1 } from "object-hash";

/* Table */

type Scalar = string | number | boolean | null | undefined;

type ScalarDict = {
  [key: string]: Scalar;
};

export type CellProps = React.PropsWithChildren<{ column: number }>;

export type TableProps<T extends ScalarDict> = {
  /**
   * List of values (rows).
   */
  data: T[];
  /**
   * Columns that we should display in the table.
   */
  columns: (keyof T)[];
  /**
   * Cell padding.
   */
  padding: number;
  /**
   * Header component.
   */
  header: (props: React.PropsWithChildren<unknown>) => React.JSX.Element;
  /**
   * Component used to render a cell in the table.
   */
  cell: (props: CellProps) => React.JSX.Element;
  /**
   * Component used to render the skeleton of the table.
   */
  skeleton: (props: React.PropsWithChildren<unknown>) => React.JSX.Element;
};

/* Table */

export default class Table<T extends ScalarDict> extends React.Component<
  Pick<TableProps<T>, "data"> & Partial<TableProps<T>>
> {
  /* Config */

  /**
   * Merges provided configuration with defaults.
   */
  getConfig(): TableProps<T> {
    return {
      data: this.props.data,
      columns: this.props.columns || this.getDataKeys(),
      padding: this.props.padding || 1,
      header: this.props.header || Header,
      cell: this.props.cell || Cell,
      skeleton: this.props.skeleton || Skeleton,
    };
  }

  /**
   * Gets all keyes used in data by traversing through the data.
   */
  getDataKeys(): (keyof T)[] {
    const keys = new Set<keyof T>();

    // Collect all the keys.
    for (const data of this.props.data) {
      for (const key in data) {
        keys.add(key);
      }
    }

    return Array.from(keys);
  }

  /**
   * Calculates the width of each column by finding
   * the longest value in a cell of a particular column.
   *
   * Returns a list of column names and their widths.
   */
  getColumns(): Column<T>[] {
    const { columns, padding } = this.getConfig();

    const widths: Column<T>[] = columns.map((key) => {
      const header = String(key).length;
      /* Get the width of each cell in the column */
      const data = this.props.data.map((data) => {
        const value = data[key];

        if (value == undefined || value == null) return 0;
        return String(value).length;
      });

      const width = Math.max(...data, header) + padding * 2;

      /* Construct a cell */
      return {
        column: key,
        width: width,
        key: String(key),
      };
    });

    return widths;
  }

  /**
   * Returns a (data) row representing the headings.
   */
  getHeadings(): Partial<T> {
    const { columns } = this.getConfig();

    const headings: Partial<T> = columns.reduce(
      (acc, column) => ({ ...acc, [column]: column }),
      {}
    );

    return headings;
  }

  /* Rendering utilities */

  // The top most line in the table.
  header = row<T>({
    cell: this.getConfig().skeleton,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      // chars
      line: "─",
      left: "┌",
      right: "┐",
      cross: "┬",
    },
  });

  // The line with column names.
  heading = row<T>({
    cell: this.getConfig().header,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      // chars
      line: " ",
      left: "│",
      right: "│",
      cross: "│",
    },
  });

  // The line that separates rows.
  separator = row<T>({
    cell: this.getConfig().skeleton,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      // chars
      line: "─",
      left: "├",
      right: "┤",
      cross: "┼",
    },
  });

  // The row with the data.
  data = row<T>({
    cell: this.getConfig().cell,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      // chars
      line: " ",
      left: "│",
      right: "│",
      cross: "│",
    },
  });

  // The bottom most line of the table.
  footer = row<T>({
    cell: this.getConfig().skeleton,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      // chars
      line: "─",
      left: "└",
      right: "┘",
      cross: "┴",
    },
  });

  /* Render */
  override render() {
    /* Data */
    const columns = this.getColumns();
    const headings = this.getHeadings();

    /**
     * Render the table line by line.
     */
    return (
      <Box flexDirection="column">
        {/* Header */}
        {this.header({ key: "header", columns, data: {} })}
        {this.heading({ key: "heading", columns, data: headings })}
        {/* Data */}
        {this.props.data.map((row, index) => {
          // Calculate the hash of the row based on its value and position
          const key = `row-${sha1(row)}-${index}`;

          // Construct a row.
          return (
            <Box flexDirection="column" key={key}>
              {this.separator({ key: `separator-${key}`, columns, data: {} })}
              {this.data({ key: `data-${key}`, columns, data: row })}
            </Box>
          );
        })}
        {/* Footer */}
        {this.footer({ key: "footer", columns, data: {} })}
      </Box>
    );
  }
}

/* Helper components */

type RowConfig = {
  /**
   * Component used to render cells.
   */
  cell: (props: CellProps) => React.JSX.Element;
  /**
   * Tells the padding of each cell.
   */
  padding: number;
  /**
   * Component used to render skeleton in the row.
   */
  skeleton: {
    component: (props: React.PropsWithChildren<unknown>) => React.JSX.Element;
    /**
     * Characters used in skeleton.
     *    |             |
     * (left)-(line)-(cross)-(line)-(right)
     *    |             |
     */
    left: string;
    right: string;
    cross: string;
    line: string;
  };
};

type RowProps<T extends ScalarDict> = {
  key: string;
  data: Partial<T>;
  columns: Column<T>[];
};

type Column<T> = {
  key: string;
  column: keyof T;
  width: number;
};

/**
 * Constructs a Row element from the configuration.
 */
function row<T extends ScalarDict>(config: RowConfig): (props: RowProps<T>) => React.JSX.Element {
  /* This is a component builder. We return a function. */

  const skeleton = config.skeleton;

  /* Row */
  return (props) => (
    <Box flexDirection="row">
      {/* Left */}
      <skeleton.component>{skeleton.left}</skeleton.component>
      {/* Data */}
      {...intersperse(
        (i) => {
          const key = `${props.key}-hseparator-${i}`;

          // The horizontal separator.
          return <skeleton.component key={key}>{skeleton.cross}</skeleton.component>;
        },

        // Values.
        props.columns.map((column, colI) => {
          // content
          const value = props.data[column.column];

          if (value == undefined || value == null) {
            const key = `${props.key}-empty-${column.key}`;

            return (
              <config.cell key={key} column={colI}>
                {skeleton.line.repeat(column.width)}
              </config.cell>
            );
          } else {
            const key = `${props.key}-cell-${column.key}`;

            // margins
            const ml = config.padding;
            const mr = column.width - String(value).length - config.padding;

            return (
              /* prettier-ignore */
              <config.cell key={key} column={colI}>
                {`${skeleton.line.repeat(ml)}${String(value)}${skeleton.line.repeat(mr)}`}
              </config.cell>
            );
          }
        })
      )}
      {/* Right */}
      <skeleton.component>{skeleton.right}</skeleton.component>
    </Box>
  );
}

/**
 * Renders the header of a table.
 */
export function Header(props: React.PropsWithChildren<unknown>) {
  return (
    <Text bold color="blue">
      {props.children}
    </Text>
  );
}

/**
 * Renders a cell in the table.
 */
export function Cell(props: CellProps) {
  return <Text>{props.children}</Text>;
}

/**
 * Redners the scaffold of the table.
 */
export function Skeleton(props: React.PropsWithChildren<unknown>) {
  return <Text bold>{props.children}</Text>;
}

/* Utility functions */

/**
 * Intersperses a list of elements with another element.
 */
function intersperse<T, I>(intersperser: (index: number) => I, elements: T[]): (T | I)[] {
  // Intersparse by reducing from left.
  const interspersed: (T | I)[] = elements.reduce(
    (acc, element, index) => {
      // Only add element if it's the first one.
      if (acc.length === 0) return [element];
      // Add the intersparser as well otherwise.
      return [...acc, intersperser(index), element];
    },
    [] as (T | I)[]
  );

  return interspersed;
}

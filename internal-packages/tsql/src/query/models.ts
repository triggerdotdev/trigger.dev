// TypeScript translation of posthog/hogql/database/models.py

import type { Expr, ConstantType } from "./ast";
import type { TSQLContext } from "./context";

export interface FieldOrTable {
  hidden?: boolean;
}

export interface DatabaseField extends FieldOrTable {
  name: string;
  array?: boolean;
  nullable?: boolean;
  is_nullable?(): boolean;
  get_constant_type?(): ConstantType;
  default_value?(): any;
}

export interface IntegerDatabaseField extends DatabaseField {}
export interface FloatDatabaseField extends DatabaseField {}
export interface DecimalDatabaseField extends DatabaseField {}
export interface StringDatabaseField extends DatabaseField {}
export interface UnknownDatabaseField extends DatabaseField {}
export interface StringJSONDatabaseField extends DatabaseField {}
export interface StringArrayDatabaseField extends DatabaseField {}
export interface FloatArrayDatabaseField extends DatabaseField {}
export interface DateDatabaseField extends DatabaseField {}
export interface DateTimeDatabaseField extends DatabaseField {}
export interface BooleanDatabaseField extends DatabaseField {}
export interface UUIDDatabaseField extends DatabaseField {}

export interface ExpressionField extends DatabaseField {
  expr: Expr;
  isolate_scope?: boolean;
}

export interface FieldTraverser extends FieldOrTable {
  chain: Array<string | number>;
}

export interface Table extends FieldOrTable {
  fields: Record<string, FieldOrTable>;
  has_field?(name: string | number): boolean;
  get_field?(name: string | number): FieldOrTable;
  to_printed_clickhouse?(context: TSQLContext): string;
  to_printed_tsql?(): string;
  avoid_asterisk_fields?(): string[];
  get_asterisk?(): Record<string, FieldOrTable>;
}

export interface LazyJoin extends FieldOrTable {
  join_function?(from_table: Table, to_table: Table, requesting_table: Table): Expr;
  resolve_table?(context: TSQLContext): Table;
}

export interface LazyTable extends Table {}

export interface VirtualTable extends Table {}

export interface SavedQuery extends Table {
  query: Expr;
}

export interface FunctionCallTable extends Table {
  call_function?(context: TSQLContext): Expr;
}

export interface TableNode {
  name: "root" | string;
  table?: FieldOrTable | null;
  children: Record<string, TableNode>;
  get?(): FieldOrTable;
  has_child?(path: string[]): boolean;
  get_child?(path: string[]): TableNode;
  add_child?(
    child: TableNode,
    options?: {
      table_conflict_mode?: "override" | "ignore";
      children_conflict_mode?: "override" | "merge" | "ignore";
    }
  ): void;
  merge_with?(
    other: TableNode,
    options?: {
      table_conflict_mode?: "override" | "ignore";
      children_conflict_mode?: "override" | "merge" | "ignore";
    }
  ): void;
  resolve_all_table_names?(): string[];
}

// Basic TableNode implementation class
export class TableNodeImpl implements TableNode {
  name: "root" | string;
  table?: FieldOrTable | null;
  children: Record<string, TableNode>;

  constructor(name: "root" | string = "root", table?: FieldOrTable | null) {
    this.name = name;
    this.table = table || null;
    this.children = {};
  }

  get(): FieldOrTable {
    if (this.table === null || this.table === undefined) {
      throw new Error(`Table is not set at \`${this.name}\``);
    }
    return this.table;
  }

  has_child(path: string[]): boolean {
    if (path.length === 0) {
      return this.table !== null && this.table !== undefined;
    }

    const [first, ...restOfPath] = path;
    if (!(first in this.children)) {
      return false;
    }

    return this.children[first].has_child ? this.children[first].has_child!(restOfPath) : false;
  }

  get_child(path: string[]): TableNode {
    if (path.length === 0) {
      return this;
    }

    const [first, ...restOfPath] = path;
    if (!(first in this.children)) {
      throw new Error(`Unknown child \`${first}\` at \`${this.name}\`.`);
    }

    return this.children[first].get_child
      ? this.children[first].get_child!(restOfPath)
      : this.children[first];
  }

  add_child(
    child: TableNode,
    options?: {
      table_conflict_mode?: "override" | "ignore";
      children_conflict_mode?: "override" | "merge" | "ignore";
    }
  ): void {
    const tableConflictMode = options?.table_conflict_mode || "ignore";
    const childrenConflictMode = options?.children_conflict_mode || "merge";

    if (child.name in this.children) {
      if (childrenConflictMode === "override") {
        this.children[child.name] = child;
      } else if (childrenConflictMode === "merge") {
        const existing = this.children[child.name];
        if (existing.merge_with) {
          existing.merge_with(child, {
            table_conflict_mode: tableConflictMode,
            children_conflict_mode: childrenConflictMode,
          });
        }
      }
      // ignore mode: do nothing
      return;
    }

    this.children[child.name] = child;
  }

  merge_with(
    other: TableNode,
    options?: {
      table_conflict_mode?: "override" | "ignore";
      children_conflict_mode?: "override" | "merge" | "ignore";
    }
  ): void {
    const tableConflictMode = options?.table_conflict_mode || "ignore";
    const childrenConflictMode = options?.children_conflict_mode || "merge";

    if (other.table !== null && other.table !== undefined) {
      if (this.table === null || this.table === undefined) {
        this.table = other.table;
      } else {
        // Conflict - check conflict mode
        if (tableConflictMode === "override") {
          this.table = other.table;
        }
        // ignore mode: do nothing
      }
    }

    for (const child of Object.values(other.children)) {
      this.add_child(child, {
        table_conflict_mode: tableConflictMode,
        children_conflict_mode: childrenConflictMode,
      });
    }
  }

  resolve_all_table_names(): string[] {
    const names: string[] = [];

    if (this.table !== null && this.table !== undefined) {
      names.push(this.name);
    }

    for (const child of Object.values(this.children)) {
      const childNames = child.resolve_all_table_names ? child.resolve_all_table_names() : [];

      // The root node should NOT include itself in the names
      if (this.name === "root") {
        names.push(...childNames);
      } else {
        names.push(...childNames.map((x) => `${this.name}.${x}`));
      }
    }

    return names;
  }

  static createNestedForChain(chain: string[], table: Table): TableNode {
    if (chain.length === 0) {
      throw new Error("Chain must have at least one element");
    }

    const start = new TableNodeImpl(chain[0]);
    let current: TableNode = start;

    for (let i = 1; i < chain.length; i++) {
      const child = new TableNodeImpl(chain[i]);
      if (current.add_child) {
        current.add_child(child);
      } else {
        current.children[child.name] = child;
      }
      current = child;
    }

    current.table = table;
    return start;
  }
}

export interface LazyTableToAdd {
  lazy_table: LazyTable;
  fields_accessed: Record<string, Array<string | number>>;
}

export interface LazyJoinToAdd {
  from_table: string;
  to_table: string;
  lazy_join: LazyJoin;
  lazy_join_type: any; // LazyJoinType from ast.ts
  fields_accessed: Record<string, Array<string | number>>;
}

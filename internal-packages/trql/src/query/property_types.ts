// TypeScript translation of posthog/hogql/transforms/property_types.py

import type {
  AST,
  Expr,
  Field,
  PropertyType,
  FieldType,
  BaseTableType,
  VirtualTableType,
  LazyJoinType,
  LazyTableType,
  Call,
  Constant,
  CallType,
  DateTimeType,
} from "./ast";
import type { TRQLContext } from "./context";
import type { BooleanDatabaseField, DateTimeDatabaseField, Table } from "./models";

// Helper function to escape TRQL identifiers
function escapeTRQLIdentifier(identifier: string | number): string {
  if (typeof identifier === "number") {
    return String(identifier);
  }
  if (identifier.includes("%")) {
    throw new Error(
      `The TRQL identifier "${identifier}" is not permitted as it contains the "%" character`
    );
  }
  // TRQL allows dollars in the identifier
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) {
    return identifier;
  }
  // Escape backticks and other special characters
  const backquoteEscapeChars: Record<string, string> = {
    "\b": "\\b",
    "\f": "\\f",
    "\r": "\\r",
    "\n": "\\n",
    "\t": "\\t",
    "\0": "\\0",
    a: "\\a",
    "\v": "\\v",
    "\\": "\\\\",
    "`": "\\`",
  };
  return `\`${identifier
    .split("")
    .map((c) => backquoteEscapeChars[c] || c)
    .join("")}\``;
}

// Visitor dispatcher - converts node type to visitor method name
// Matches Python's camel_case_pattern.sub("_", class_name).lower() logic
function getVisitorMethodName(node: AST): string {
  // Get the constructor name or use a type guard to determine the type
  const nodeType = (node as any).constructor?.name || detectNodeType(node);

  if (!nodeType) {
    return "visit_unknown";
  }

  // Convert CamelCase to snake_case (e.g., "PropertyType" -> "property_type")
  const snakeCase = nodeType
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_/, "");

  // Handle special cases (matching Python replacements)
  const replacements: Record<string, string> = {
    trqlxtag: "trqlx_tag",
    trqlxattribute: "trqlx_attribute",
    uuidtype: "uuid_type",
    string_jsontype: "string_json_type",
  };

  return replacements[snakeCase] || snakeCase;
}

// Type detection helper (since we can't use instanceof with interfaces)
function detectNodeType(node: AST): string {
  // Use property presence to detect node types
  if ("chain" in node && "type" in node && !("name" in node)) {
    return "Field";
  }
  if ("chain" in node && "field_type" in node) {
    return "PropertyType";
  }
  if ("name" in node && "args" in node && !("expr" in node)) {
    return "Call";
  }
  if ("value" in node && !("name" in node) && !("args" in node)) {
    return "Constant";
  }
  // Add more type detection as needed
  return "";
}

// Base visitor class - matches Python Visitor pattern
abstract class Visitor<T> {
  visit(node: AST | null | undefined): T {
    if (node === null || node === undefined) {
      return node as T;
    }

    // Try using accept method if available (double dispatch)
    if (node.accept) {
      return node.accept(this) as T;
    }

    // Fallback: use dispatcher
    const methodName = getVisitorMethodName(node);
    const method = (this as any)[methodName];

    if (method && typeof method === "function") {
      return method.call(this, node) as T;
    }

    // Try visit_unknown as fallback
    if ((this as any).visit_unknown) {
      return (this as any).visit_unknown(node) as T;
    }

    throw new Error(`${this.constructor.name} has no method ${methodName} or visit_unknown`);
  }
}

// TraversingVisitor - matches Python TraversingVisitor
class TraversingVisitor extends Visitor<void> {
  visitPropertyType(node: PropertyType): void {
    this.visit(node.field_type);
  }

  visitField(node: Field): void {
    if (node.type) {
      this.visit(node.type as any);
    }
  }

  visitCall(node: Call): void {
    for (const arg of node.args) {
      this.visit(arg);
    }
    if (node.params) {
      for (const param of node.params) {
        this.visit(param);
      }
    }
  }

  visitConstant(node: Constant): void {
    if (node.type) {
      this.visit(node.type as any);
    }
  }

  // Default handler for unknown types - traverse common properties
  visit_unknown(node: AST): void {
    // Traverse children based on common AST node properties
    if ("expr" in node) {
      this.visit((node as any).expr);
    }
    if ("exprs" in node) {
      for (const expr of (node as any).exprs) {
        this.visit(expr);
      }
    }
    if ("left" in node && "right" in node) {
      this.visit((node as any).left);
      this.visit((node as any).right);
    }
    if ("args" in node) {
      for (const arg of (node as any).args) {
        this.visit(arg);
      }
    }
    if ("type" in node) {
      this.visit((node as any).type);
    }
  }
}

// CloningVisitor - matches Python CloningVisitor
class CloningVisitor extends Visitor<any> {
  protected clearTypes: boolean;
  protected clearLocations: boolean;

  constructor(clearTypes: boolean = true, clearLocations: boolean = false) {
    super();
    this.clearTypes = clearTypes;
    this.clearLocations = clearLocations;
  }

  visitField(node: Field): Field {
    return {
      ...node,
      type: this.clearTypes ? undefined : node.type ? this.visit(node.type as any) : node.type,
      start: this.clearLocations ? undefined : node.start,
      end: this.clearLocations ? undefined : node.end,
    };
  }

  visitPropertyType(node: PropertyType): PropertyType {
    return {
      ...node,
      field_type: this.visit(node.field_type) as FieldType,
      start: this.clearLocations ? undefined : node.start,
      end: this.clearLocations ? undefined : node.end,
    };
  }

  visitCall(node: Call): Call {
    return {
      ...node,
      args: node.args.map((arg) => this.visit(arg)),
      params: node.params ? node.params.map((param) => this.visit(param)) : undefined,
      start: this.clearLocations ? undefined : node.start,
      end: this.clearLocations ? undefined : node.end,
      type: this.clearTypes ? undefined : node.type,
    };
  }

  visitConstant(node: Constant): Constant {
    return {
      ...node,
      start: this.clearLocations ? undefined : node.start,
      end: this.clearLocations ? undefined : node.end,
      type: this.clearTypes ? undefined : node.type,
    };
  }

  // Default handler for unknown types - shallow clone
  visit_unknown(node: AST): any {
    const cloned: any = { ...node };

    // Clone common properties
    if ("expr" in node) {
      cloned.expr = this.visit((node as any).expr);
    }
    if ("exprs" in node) {
      cloned.exprs = (node as any).exprs.map((e: any) => this.visit(e));
    }
    if ("left" in node && "right" in node) {
      cloned.left = this.visit((node as any).left);
      cloned.right = this.visit((node as any).right);
    }
    if ("args" in node) {
      cloned.args = (node as any).args.map((a: any) => this.visit(a));
    }
    if ("type" in node) {
      cloned.type = this.clearTypes ? undefined : this.visit((node as any).type);
    }

    if (this.clearLocations) {
      cloned.start = undefined;
      cloned.end = undefined;
    }

    return cloned;
  }
}

// PropertyFinder: Traverses AST to find all property references
class PropertyFinder extends TraversingVisitor {
  context: TRQLContext;
  personProperties: Set<string> = new Set();
  eventProperties: Set<string> = new Set();
  groupProperties: Map<number, Set<string>> = new Map();
  foundTimestamps: boolean = false;

  constructor(context: TRQLContext) {
    super();
    this.context = context;
  }

  visitPropertyType(node: PropertyType): void {
    if (node.field_type.name === "properties" && node.chain.length === 1) {
      const tableType = node.field_type.table_type;
      if (this.isBaseTableType(tableType)) {
        const table = tableType.resolve_database_table?.(this.context);
        if (table) {
          const tableName = table.to_printed_trql?.() || "";
          const propertyName = String(node.chain[0]);

          if (tableName === "persons" || tableName === "raw_persons") {
            this.personProperties.add(propertyName);
          } else if (tableName === "groups") {
            if (this.isLazyJoinType(tableType)) {
              if (tableType.field.startsWith("group_")) {
                const groupId = parseInt(tableType.field.split("_")[1], 10);
                if (!this.groupProperties.has(groupId)) {
                  this.groupProperties.set(groupId, new Set());
                }
                this.groupProperties.get(groupId)!.add(propertyName);
              }
            } else if (this.isLazyTableType(tableType)) {
              const globalGroupId = this.context.globals?.group_id;
              if (typeof globalGroupId === "number") {
                if (!this.groupProperties.has(globalGroupId)) {
                  this.groupProperties.set(globalGroupId, new Set());
                }
                this.groupProperties.get(globalGroupId)!.add(propertyName);
              }
            }
          } else if (tableName === "events") {
            if (this.isVirtualTableType(tableType) && tableType.field === "poe") {
              this.personProperties.add(propertyName);
            } else {
              this.eventProperties.add(propertyName);
            }
          }
        }
      }
    }
    super.visitPropertyType(node);
  }

  visitField(node: Field): void {
    super.visitField(node);
    if (this.isFieldType(node.type)) {
      const dbField = (node.type as any).resolve_database_field?.(this.context);
      if (this.isDateTimeDatabaseField(dbField)) {
        this.foundTimestamps = true;
      }
    }
  }

  private isBaseTableType(type: any): type is BaseTableType {
    return type && typeof type.resolve_database_table === "function";
  }

  private isLazyJoinType(type: any): type is LazyJoinType {
    return type && "lazy_join" in type && "field" in type;
  }

  private isLazyTableType(type: any): type is LazyTableType {
    return type && "table" in type && !("lazy_join" in type);
  }

  private isVirtualTableType(type: any): type is VirtualTableType {
    return type && "virtual_table" in type && "field" in type;
  }

  private isFieldType(type: any): type is FieldType {
    return type && typeof type.resolve_database_field === "function";
  }

  private isDateTimeDatabaseField(field: any): field is DateTimeDatabaseField {
    return field && "name" in field; // Simplified check
  }
}

// PropertySwapper: Transforms property accesses with type conversions
export class PropertySwapper extends CloningVisitor {
  timezone: string;
  eventProperties: Map<string, string>;
  personProperties: Map<string, string>;
  groupProperties: Map<string, string>;
  context: TRQLContext;
  setTimeZones: boolean;

  constructor(
    timezone: string,
    eventProperties: Map<string, string> | Record<string, string>,
    personProperties: Map<string, string> | Record<string, string>,
    groupProperties: Map<string, string> | Record<string, string>,
    context: TRQLContext,
    setTimeZones: boolean
  ) {
    super(false); // Don't clear types
    this.timezone = timezone;
    this.eventProperties =
      eventProperties instanceof Map ? eventProperties : new Map(Object.entries(eventProperties));
    this.personProperties =
      personProperties instanceof Map
        ? personProperties
        : new Map(Object.entries(personProperties));
    this.groupProperties =
      groupProperties instanceof Map ? groupProperties : new Map(Object.entries(groupProperties));
    this.context = context;
    this.setTimeZones = setTimeZones;
  }

  visitField(node: Field): any {
    if (this.isFieldType(node.type)) {
      if (this.setTimeZones) {
        const dbField = (node.type as any).resolve_database_field?.(this.context);
        if (this.isDateTimeDatabaseField(dbField)) {
          return this.createToTimeZoneCall(node);
        }
      }

      if (this.isLazyJoinType(node.type.table_type)) {
        const lazyJoinType = node.type.table_type;
        const resolvedTable = lazyJoinType.lazy_join.resolve_table?.(this.context);
        // Check if it's an S3Table-like table (has fields property)
        if (resolvedTable && "fields" in resolvedTable) {
          const field = node.chain[node.chain.length - 1];
          const fieldType = resolvedTable.fields[String(field)];
          let propType = "String";

          if (this.isDateTimeDatabaseField(fieldType)) {
            propType = "DateTime";
          } else if (this.isBooleanDatabaseField(fieldType)) {
            propType = "Boolean";
          }

          return this.fieldTypeToPropertyCall(node, propType);
        }
      }
    }

    const type = node.type;
    if (
      this.isPropertyType(type) &&
      type.field_type.name === "properties" &&
      type.chain.length === 1
    ) {
      const propertyName = String(type.chain[0]);
      const tableType = type.field_type.table_type;

      if (this.isVirtualTableType(tableType) && tableType.field === "poe") {
        if (this.personProperties.has(propertyName)) {
          return this.convertStringPropertyToType(node, "person", propertyName);
        }
      } else if (this.isBaseTableType(tableType)) {
        const table = tableType.resolve_database_table?.(this.context);
        if (table) {
          const tableName = table.to_printed_trql?.() || "";

          if (tableName === "persons" || tableName === "raw_persons") {
            if (this.personProperties.has(propertyName)) {
              return this.convertStringPropertyToType(node, "person", propertyName);
            }
          } else if (tableName === "groups") {
            if (this.isLazyJoinType(tableType)) {
              if (tableType.field.startsWith("group_")) {
                const groupId = parseInt(tableType.field.split("_")[1], 10);
                const groupKey = `${groupId}_${propertyName}`;
                if (this.groupProperties.has(groupKey)) {
                  return this.convertStringPropertyToType(node, "group", groupKey);
                }
              }
            } else if (this.isLazyTableType(tableType)) {
              const globalGroupId = this.context.globals?.group_id;
              if (typeof globalGroupId === "number") {
                const groupKey = `${globalGroupId}_${propertyName}`;
                if (this.groupProperties.has(groupKey)) {
                  return this.convertStringPropertyToType(node, "group", groupKey);
                }
              }
            }
          } else if (tableName === "events") {
            if (this.eventProperties.has(propertyName)) {
              return this.convertStringPropertyToType(node, "event", propertyName);
            }
          }
        }
      }
    }

    if (
      this.isPropertyType(type) &&
      type.field_type.name === "person_properties" &&
      type.chain.length === 1
    ) {
      const propertyName = String(type.chain[0]);
      const tableType = type.field_type.table_type;

      if (this.isBaseTableType(tableType)) {
        const table = tableType.resolve_database_table?.(this.context);
        if (table) {
          const tableName = table.to_printed_trql?.() || "";
          if (tableName === "events") {
            if (this.personProperties.has(propertyName)) {
              return this.convertStringPropertyToType(node, "person", propertyName);
            }
          }
        }
      }
    }

    return super.visitField(node);
  }

  private convertStringPropertyToType(
    node: Field,
    propertyType: "event" | "person" | "group",
    propertyName: string
  ): Expr {
    let fieldTypeValue: string | undefined;
    if (propertyType === "person") {
      fieldTypeValue = this.personProperties.get(propertyName);
    } else if (propertyType === "group") {
      fieldTypeValue = this.groupProperties.get(propertyName);
    } else {
      fieldTypeValue = this.eventProperties.get(propertyName);
    }

    const fieldType = fieldTypeValue === "Numeric" ? "Float" : fieldTypeValue || "String";
    this.addPropertyNotice(node, propertyType, fieldType);

    return this.fieldTypeToPropertyCall(node, fieldType);
  }

  private fieldTypeToPropertyCall(node: Field, fieldType: string): Expr {
    if (fieldType === "DateTime") {
      return this.createToDateTimeCall(node);
    }
    if (fieldType === "Float") {
      return this.createToFloatCall(node);
    }
    if (fieldType === "Boolean") {
      return this.createToBoolCall(node);
    }
    return node;
  }

  private createToTimeZoneCall(node: Field): Call {
    return {
      expression_type: "call",
      name: "toTimeZone",
      args: [node, this.createConstant(this.timezone)],
      type: {
        name: "toTimeZone",
        arg_types: [{ data_type: "datetime" } as DateTimeType],
        return_type: { data_type: "datetime" } as DateTimeType,
      } as CallType,
      start: node.start,
      end: node.end,
    } as Call;
  }

  private createToDateTimeCall(node: Field): Call {
    return {
      expression_type: "call",
      name: "toDateTime",
      args: [node],
      start: node.start,
      end: node.end,
    };
  }

  private createToFloatCall(node: Field): Call {
    return {
      expression_type: "call",
      name: "toFloat",
      args: [node],
      start: node.start,
      end: node.end,
    };
  }

  private createToBoolCall(node: Field): Call {
    return {
      expression_type: "call",
      name: "toBool",
      args: [
        {
          name: "transform",
          args: [
            {
              name: "toString",
              args: [node],
              start: node.start,
              end: node.end,
            } as Call,
            this.createConstant(["true", "false"]),
            this.createConstant([1, 0]),
            this.createConstant(null),
          ],
          start: node.start,
          end: node.end,
        } as Call,
      ],
      start: node.start,
      end: node.end,
    } as Call;
  }

  private createConstant(value: any): Constant {
    return {
      expression_type: "constant",
      value,
    };
  }

  private addPropertyNotice(
    node: Field,
    propertyType: "event" | "person" | "group",
    fieldType: string
  ): void {
    let propertyName = String(node.chain[node.chain.length - 1]);
    let materializedColumn: any = null; // MaterializedColumn type not yet defined

    if (propertyType === "person") {
      //   if (this.context.modifiers.personsOnEventsMode !== "disabled") {
      // materializedColumn = getMaterializedColumnForProperty('events', propertyName, 'person_properties');
      //   } else {
      // materializedColumn = getMaterializedColumnForProperty('person', propertyName, 'properties');
      //   }
    } else if (propertyType === "group") {
      const nameParts = propertyName.split("_");
      nameParts.shift();
      propertyName = nameParts.join("_");
      // materializedColumn = getMaterializedColumnForProperty('groups', propertyName, 'properties');
    } else {
      // materializedColumn = getMaterializedColumnForProperty('events', propertyName, 'properties');
    }

    let message = `${
      propertyType.charAt(0).toUpperCase() + propertyType.slice(1)
    } property '${propertyName}' is of type '${fieldType}'.`;
    if (this.context.debug) {
      if (materializedColumn !== null) {
        message += " This property is materialized ⚡️.";
      } else {
        message += " This property is not materialized 🐢.";
      }
    }

    this.addNotice(node, message);
  }

  private addNotice(node: Field, message: string): void {
    if (node.start === undefined || node.end === undefined) {
      return; // Don't add notices for nodes without location
    }
    // Only highlight the last part of the chain
    const lastPart = node.chain[node.chain.length - 1];
    const identifierLength = escapeTRQLIdentifier(lastPart).length;
    this.context.notices.push({
      start: Math.max(node.start, node.end - identifierLength),
      end: node.end,
      message,
    });
  }

  private isFieldType(type: any): type is FieldType {
    return type && typeof type.resolve_database_field === "function";
  }

  private isPropertyType(type: any): type is PropertyType {
    return type && "field_type" in type && "chain" in type;
  }

  private isBaseTableType(type: any): type is BaseTableType {
    return type && typeof type.resolve_database_table === "function";
  }

  private isLazyJoinType(type: any): type is LazyJoinType {
    return type && "lazy_join" in type && "field" in type;
  }

  private isLazyTableType(type: any): type is LazyTableType {
    return type && "table" in type && !("lazy_join" in type);
  }

  private isVirtualTableType(type: any): type is VirtualTableType {
    return type && "virtual_table" in type && "field" in type;
  }

  private isDateTimeDatabaseField(field: any): field is DateTimeDatabaseField {
    return field && "name" in field; // Simplified check
  }

  private isBooleanDatabaseField(field: any): field is BooleanDatabaseField {
    return field && "name" in field; // Simplified check
  }
}

// Main function to build property swapper
export function buildPropertySwapper(node: AST, context: TRQLContext): void {
  if (!context || !context.team_id) {
    return;
  }

  // NOTE: In TypeScript, you'll need to fetch the team from your database/ORM
  // This is a placeholder - replace with your actual team fetching logic
  // if (!context.team) {
  //     context.team = await Team.findById(context.team_id);
  // }

  if (!context.team) {
    return;
  }

  // Find all properties
  const propertyFinder = new PropertyFinder(context);
  propertyFinder.visit(node);

  // NOTE: In TypeScript, you'll need to query PropertyDefinition from your database
  // This is a placeholder - replace with your actual property definition fetching logic
  // const eventPropertyValues = await PropertyDefinition.find({
  //     project_id: context.team.project_id,
  //     name: { $in: Array.from(propertyFinder.eventProperties) },
  //     type: { $in: [null, 'event'] },
  // }).select('name property_type');
  // const eventProperties = new Map(
  //     eventPropertyValues.filter((p: any) => p.property_type).map((p: any) => [p.name, p.property_type])
  // );

  const eventProperties = new Map<string, string>();
  const personProperties = new Map<string, string>();
  const groupProperties = new Map<string, string>();

  // TODO: Implement actual property definition fetching from database
  // For now, these are empty maps

  const timezone = (context.database as any)?._timezone || "UTC";
  context.property_swapper = new PropertySwapper(
    timezone,
    eventProperties,
    personProperties,
    groupProperties,
    context,
    true
  );
}

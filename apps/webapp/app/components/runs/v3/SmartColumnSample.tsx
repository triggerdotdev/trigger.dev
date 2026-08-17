import { useState } from "react";
import { cn } from "~/utils/cn";

/** Max children rendered per node so a large blob can't blow up the DOM. */
const MAX_CHILDREN = 200;
/** Levels auto-expanded; deeper nodes start collapsed and open on click. */
const AUTO_OPEN_DEPTH = 2;
const MAX_STRING = 80;

/**
 * A clickable, syntax-colored JSON tree for the smart-column sample. Only leaf
 * values are selectable: clicking one fills the JSON path field via
 * `onSelectPath` and highlights it. Object/array rows only expand and collapse,
 * so you drill into a container and pick a leaf inside it.
 */
export function SmartColumnSample({
  value,
  activePath,
  onSelectPath,
}: {
  value: unknown;
  activePath: string;
  onSelectPath: (path: string) => void;
}) {
  return (
    <div className="max-h-52 overflow-auto rounded bg-charcoal-900 p-2 font-mono text-xs leading-relaxed">
      <JsonNode
        name={undefined}
        path="$"
        value={value}
        depth={0}
        activePath={activePath}
        onSelectPath={onSelectPath}
      />
    </div>
  );
}

function childPath(parentPath: string, key: string | number): string {
  if (typeof key === "number") return `${parentPath}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parentPath}.${key}`;
  return `${parentPath}['${key.replace(/'/g, "\\'")}']`;
}

function JsonNode({
  name,
  path,
  value,
  depth,
  activePath,
  onSelectPath,
}: {
  name: string | number | undefined;
  path: string;
  value: unknown;
  depth: number;
  activePath: string;
  onSelectPath: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < AUTO_OPEN_DEPTH);
  const isObject = value !== null && typeof value === "object";
  const selected = path === activePath;
  const keyLabel = name === undefined ? null : typeof name === "number" ? name : `"${name}"`;

  if (!isObject) {
    const target = name === undefined ? "$" : path;
    return (
      <button
        type="button"
        onClick={() => onSelectPath(target)}
        className={cn(
          "flex w-full items-baseline whitespace-pre rounded px-0.5 text-left hover:bg-blue-500/15",
          selected && "bg-blue-500/25"
        )}
      >
        {keyLabel !== null && <span className="text-sky-300">{keyLabel}</span>}
        {keyLabel !== null && <span className="text-text-dimmed">: </span>}
        <PrimitiveValue value={value} />
      </button>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const shown = entries.slice(0, MAX_CHILDREN);
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Collapse" : "Expand"}
        aria-expanded={open}
        className="flex w-full items-start whitespace-pre rounded px-0.5 text-left hover:bg-charcoal-750"
      >
        <span className="mr-1 w-3 shrink-0 text-text-dimmed">{open ? "▾" : "▸"}</span>
        {keyLabel !== null && <span className="text-sky-300">{keyLabel}</span>}
        {keyLabel !== null && <span className="text-text-dimmed">: </span>}
        <span className="text-text-dimmed">
          {openBrace}
          {!open && `… ${closeBrace}`}
          {!open && entries.length > 0 && (
            <span className="ml-1 text-faint">{`${entries.length} ${isArray ? "items" : "keys"}`}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="ml-[0.4rem] border-l border-grid-dimmed/50 pl-3">
          {shown.map(([key, childValue]) => (
            <JsonNode
              key={String(key)}
              name={key}
              path={childPath(path, key)}
              value={childValue}
              depth={depth + 1}
              activePath={activePath}
              onSelectPath={onSelectPath}
            />
          ))}
          {entries.length > MAX_CHILDREN && (
            <div className="text-text-dimmed">… {entries.length - MAX_CHILDREN} more</div>
          )}
          <div className="text-text-dimmed">{closeBrace}</div>
        </div>
      )}
    </div>
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-purple-400">null</span>;
  if (typeof value === "string") {
    const truncated = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    return <span className="text-green-400">"{truncated}"</span>;
  }
  if (typeof value === "number") return <span className="text-amber-400">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-purple-400">{String(value)}</span>;
  return <span className="text-text-dimmed">{String(value)}</span>;
}

import { useState } from "react";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Switch } from "~/components/primitives/Switch";
import { useDebounce } from "~/hooks/useDebounce";
import { useHasAdminAccess } from "~/hooks/useUser";

export function RunToolbar({
  filters,
  status,
  actions,
}: {
  filters?: React.ReactNode;
  status?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-grid-bright pl-1.5 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
        {filters}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {status}
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

export function TraceFilters({
  onFilterTextChange,
  showQueueTime,
  onShowQueueTimeChange,
  errorsOnly,
  onErrorsOnlyChange,
  debug,
}: {
  onFilterTextChange: (text: string) => void;
  /** Omit to hide the Queue time switch. */
  showQueueTime?: boolean;
  onShowQueueTimeChange?: (show: boolean) => void;
  errorsOnly: boolean;
  onErrorsOnlyChange: (errorsOnly: boolean) => void;
  /** Admin-only Debug switch; omit to hide it. */
  debug?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  const isAdmin = useHasAdminAccess();

  return (
    <>
      <SearchField onChange={onFilterTextChange} />
      {onShowQueueTimeChange && (
        <Switch
          variant="secondary/small"
          label="Queue time"
          checked={showQueueTime ?? false}
          onCheckedChange={(e) => onShowQueueTimeChange(e.valueOf())}
          shortcut={{ key: "Q" }}
        />
      )}
      <Switch
        variant="secondary/small"
        label="Errors only"
        checked={errorsOnly}
        onCheckedChange={(e) => onErrorsOnlyChange(e.valueOf())}
      />
      {isAdmin && debug && (
        <Switch
          variant="secondary/small"
          label="Debug"
          shortcut={{ modifiers: ["shift"], key: "D" }}
          checked={debug.checked}
          onCheckedChange={debug.onChange}
        />
      )}
    </>
  );
}

function SearchField({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("");

  const updateFilterText = useDebounce((text: string) => {
    onChange(text);
  }, 250);

  const updateValue = (next: string) => {
    setValue(next);
    updateFilterText(next);
  };

  return <SearchInput placeholder="Search logs…" value={value} onValueChange={updateValue} />;
}

import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Input } from "~/components/primitives/Input";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";

export type SearchInputProps = {
  placeholder?: string;
  /** The URL search param name to read/write. Defaults to "search". */
  paramName?: string;
  /** Additional URL params to reset when searching or clearing (e.g. pagination). Defaults to ["cursor", "direction"]. */
  resetParams?: string[];
  autoFocus?: boolean;
  /**
   * Controlled value. When provided alongside `onValueChange`, the input
   * skips URL params entirely and acts as a controlled component — useful
   * for client-side filters (e.g. tree filtering) that don't round-trip
   * to the server.
   */
  value?: string;
  /**
   * Called on every keystroke and on clear when in controlled mode. The
   * presence of this prop is what switches the input into controlled
   * mode; `paramName`/`resetParams` are ignored when it's set.
   */
  onValueChange?: (value: string) => void;
};

export function SearchInput({
  placeholder = "Search logs…",
  paramName = "search",
  resetParams = ["cursor", "direction"],
  autoFocus,
  value: controlledValue,
  onValueChange,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const { value, replace, del } = useSearchParams();
  const isControlled = onValueChange !== undefined;

  const initialSearch = isControlled ? (controlledValue ?? "") : (value(paramName) ?? "");

  const [text, setText] = useState(initialSearch);
  const [isFocused, setIsFocused] = useState(false);

  // Compare against a ref, not `text`, so the effect stays off the keystroke path.
  // Trade-off: controlled mode assumes the parent accepts onValueChange; it won't
  // re-sync `text` if the parent rejects a change and holds `value` unchanged.
  const lastSyncedRef = useRef(initialSearch);

  useEffect(() => {
    if (isControlled) {
      if (controlledValue !== undefined && controlledValue !== lastSyncedRef.current) {
        lastSyncedRef.current = controlledValue;
        setText(controlledValue);
      }
      return;
    }
    const urlSearch = value(paramName) ?? "";
    if (urlSearch === lastSyncedRef.current) return;
    // Only mark synced once we actually apply it, so a URL change during focus still syncs on blur.
    if (!isFocused) {
      lastSyncedRef.current = urlSearch;
      setText(urlSearch);
    }
  }, [isControlled, controlledValue, value, isFocused, paramName]);

  const updateText = (next: string) => {
    setText(next);
    if (isControlled) {
      onValueChange?.(next);
    }
  };

  const handleSubmit = () => {
    if (isControlled) {
      // Live updates already fired through onValueChange; submit is a no-op.
      return;
    }
    const resetValues = Object.fromEntries(resetParams.map((p) => [p, undefined]));
    if (text.trim()) {
      replace({ [paramName]: text.trim(), ...resetValues });
    } else {
      del([paramName, ...resetParams]);
    }
  };

  const handleClear = () => {
    setText("");
    if (isControlled) {
      onValueChange?.("");
    } else {
      del([paramName, ...resetParams]);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <motion.div
        initial={{ width: "auto" }}
        animate={{ width: isFocused && text.length > 0 ? "24rem" : "auto" }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30,
        }}
        className="relative h-6 min-w-52"
      >
        <Input
          type="text"
          ref={inputRef}
          variant="secondary-small"
          placeholder={placeholder}
          value={text}
          onChange={(e) => updateText(e.target.value)}
          fullWidth
          autoFocus={autoFocus}
          className={cn("", isFocused && "placeholder:text-text-dimmed/70")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === "Escape") {
              if (text.length > 0) {
                e.stopPropagation();
                handleClear();
              } else {
                e.currentTarget.blur();
              }
            }
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          icon={<MagnifyingGlassIcon className="size-4 text-text-bright" />}
          accessory={
            text.length > 0 ? (
              <div className="-mr-1 flex items-center gap-1.5">
                {!isControlled && (
                  <ShortcutKey
                    shortcut={{ key: "enter" }}
                    variant="medium"
                    className="border-none"
                  />
                )}
                <SimpleTooltip
                  asChild
                  button={
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleClear()}
                      className="flex size-4.5 items-center justify-center rounded-[2px] border border-text-dimmed/40 text-text-dimmed transition hover:bg-charcoal-600 hover:text-text-bright"
                    >
                      <XMarkIcon className="size-3" />
                    </button>
                  }
                  content={
                    <div className="flex items-center gap-1">
                      <span className="text-text-dimmed">Clear field</span>
                      <ShortcutKey shortcut={{ key: "esc" }} variant="small" />
                    </div>
                  }
                  className="px-2 py-1.5 text-xs"
                  disableHoverableContent
                />
              </div>
            ) : undefined
          }
        />
      </motion.div>
    </div>
  );
}

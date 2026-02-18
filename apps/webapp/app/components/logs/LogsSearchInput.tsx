import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "~/components/primitives/Input";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { cn } from "~/utils/cn";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";

export function LogsSearchInput() {
  const location = useOptimisticLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  const { value, replace, del } = useSearchParams();

  // Get initial search value from URL
  const initialSearch = value("search") ?? "";

  const [text, setText] = useState(initialSearch);
  const [isFocused, setIsFocused] = useState(false);

  // Update text when URL search param changes (only when not focused to avoid overwriting user input)
  useEffect(() => {
    const urlSearch = value("search") ?? "";
    if (urlSearch !== text && !isFocused) {
      setText(urlSearch);
    }
  }, [value, text, isFocused]);

  const handleSubmit = useCallback(() => {
    if (text.trim()) {
      replace({ search: text.trim() });
    } else {
      del("search");
    }
  }, [text, replace, del]);

  const handleClear = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setText("");
      del(["search", "cursor", "direction"]);
    },
    [del]
  );

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
          placeholder="Search logs…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          fullWidth
          className={cn("", isFocused && "placeholder:text-text-dimmed/70")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          icon={<MagnifyingGlassIcon className="size-4" />}
          accessory={
            text.length > 0 ? (
              <div className="-mr-1 flex items-center gap-1">
                <ShortcutKey shortcut={{ key: "enter" }} variant="small" />
                <button
                  type="button"
                  onClick={handleClear}
                  className="flex size-4.5 items-center justify-center rounded-[2px] border border-text-dimmed/40 text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
                  title="Clear search"
                >
                  <XMarkIcon className="size-3" />
                </button>
              </div>
            ) : undefined
          }
        />
      </motion.div>
    </div>
  );
}

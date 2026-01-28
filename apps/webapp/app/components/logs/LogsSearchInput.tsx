import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "~/components/primitives/Input";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { cn } from "~/utils/cn";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";

export function LogsSearchInput() {
  const location = useOptimisticLocation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  // Get initial search value from URL
  const searchParams = new URLSearchParams(location.search);
  const initialSearch = searchParams.get("search") ?? "";

  const [text, setText] = useState(initialSearch);
  const [isFocused, setIsFocused] = useState(false);

  // Update text when URL search param changes (only when not focused to avoid overwriting user input)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const urlSearch = params.get("search") ?? "";
    if (urlSearch !== text && !isFocused) {
      setText(urlSearch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const handleSubmit = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (text.trim()) {
      params.set("search", text.trim());
    } else {
      params.delete("search");
    }
    // Reset cursor when searching
    params.delete("cursor");
    params.delete("direction");
    navigate(`${location.pathname}?${params.toString()}`, { replace: true });
  }, [text, location.pathname, location.search, navigate]);

  const handleClear = useCallback(() => {
    setText("");
    const params = new URLSearchParams(location.search);
    params.delete("search");
    params.delete("cursor");
    params.delete("direction");
    navigate(`${location.pathname}?${params.toString()}`, { replace: true });
  }, [location.pathname, location.search, navigate]);

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
          className={cn(isFocused && "placeholder:text-text-dimmed/70")}
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
              <ShortcutKey shortcut={{ key: "enter" }} variant="small" />
            ) : undefined
          }
        />
      </motion.div>

      {text.length > 0 && (
        <button
          type="button"
          onClick={handleClear}
          className="flex size-6 items-center justify-center rounded text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
          title="Clear search"
        >
          <XMarkIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

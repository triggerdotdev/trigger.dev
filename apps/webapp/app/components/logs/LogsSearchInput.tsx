import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Input } from "~/components/primitives/Input";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { cn } from "~/utils/cn";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { AIFilterInput } from "~/components/runs/v3/AIFilterInput";

type SearchMode = "ai" | "text";

export function LogsSearchInput() {
  const location = useOptimisticLocation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  // Get initial search value from URL
  const searchParams = new URLSearchParams(location.search);
  const initialSearch = searchParams.get("search") ?? "";

  const [mode, setMode] = useState<SearchMode>("text");
  const [text, setText] = useState(initialSearch);
  const [isFocused, setIsFocused] = useState(false);

  // Update text when URL search param changes (only when not focused to avoid overwriting user input)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const urlSearch = params.get("search") ?? "";
    if (urlSearch !== text && !isFocused) {
      setText(urlSearch);
    }
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

  const toggleMode = useCallback(() => {
    // Clear text search when switching modes
    if (mode === "text" && text.trim()) {
      handleClear();
    }
    setMode((prev) => (prev === "ai" ? "text" : "ai"));
  }, [mode, text, handleClear]);

  return (
    <div className="flex items-center gap-1">
      {/* Mode toggle button */}
      <button
        type="button"
        onClick={toggleMode}
        className={cn(
          "flex size-6 items-center justify-center rounded border transition-colors",
          mode === "ai"
            ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20"
            : "border-charcoal-700 bg-charcoal-750 text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
        )}
        title={mode === "ai" ? "Switch to text search" : "Switch to AI search"}
      >
        {mode === "ai" ? (
          <AISparkleIcon className="size-3.5" />
        ) : (
          <MagnifyingGlassIcon className="size-3.5" />
        )}
      </button>

      {/* Show AI or text search based on mode */}
      {mode === "ai" ? (
        <AIFilterInput />
      ) : (
        <div className="flex items-center gap-1">
          <div className="relative h-6 min-w-52">
            <Input
              type="text"
              ref={inputRef}
              variant="secondary-small"
              placeholder="Search messages…"
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
          </div>

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
      )}
    </div>
  );
}

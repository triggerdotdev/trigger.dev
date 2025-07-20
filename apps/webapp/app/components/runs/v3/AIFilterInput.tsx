import { Portal } from "@radix-ui/react-portal";
import { useFetcher, useNavigate } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Input } from "~/components/primitives/Input";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { objectToSearchParams } from "~/utils/searchParams";
import { type TaskRunListSearchFilters } from "./RunFilters";
import { cn } from "~/utils/cn";
import { motion, AnimatePresence } from "framer-motion";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";

type AIFilterResult =
  | {
      success: true;
      filters: TaskRunListSearchFilters;
      explanation?: string;
    }
  | {
      success: false;
      error: string;
      suggestions?: string[];
    };

export function AIFilterInput() {
  const [text, setText] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const inputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher<AIFilterResult>();

  useEffect(() => {
    if (fetcher.data?.success && fetcher.state === "loading") {
      // Clear the input after successful application
      setText("");
      // Ensure focus is removed after successful submission
      setIsFocused(false);

      const searchParams = objectToSearchParams(fetcher.data.filters);
      if (!searchParams) {
        return;
      }

      console.log("AI filter success", {
        data: fetcher.data,
        searchParams: searchParams.toString(),
      });

      navigate(`${location.pathname}?${searchParams.toString()}`, { replace: true });

      //focus the input again
      if (inputRef.current) {
        inputRef.current.focus();
      }

      // TODO: Show success message with explanation
      console.log(`AI applied filters: ${fetcher.data.explanation}`);
    } else if (fetcher.data?.success === false) {
      // TODO: Show error with suggestions
      console.error(fetcher.data.error, fetcher.data.suggestions);
    }
  }, [fetcher.data, navigate]);

  const isLoading = fetcher.state === "submitting";

  return (
    <fetcher.Form
      className="flex items-center gap-2"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/ai-filter`}
      method="post"
    >
      <ErrorPopover error={fetcher.data?.success === false ? fetcher.data.error : undefined}>
        <motion.div
          initial={{ width: "auto" }}
          animate={{ width: isFocused && text.length > 0 ? "24rem" : "auto" }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
          }}
          className="relative h-6 min-w-44"
        >
          <AnimatePresence>
            {isFocused && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "linear" }}
                className="animated-gradient-glow-small pointer-events-none absolute inset-0 h-6"
              />
            )}
          </AnimatePresence>
          <div className="absolute inset-0 left-0 top-0 h-6">
            <Input
              type="text"
              name="text"
              variant="secondary-small"
              placeholder="Describe your filters…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={isLoading}
              fullWidth
              ref={inputRef}
              className={cn(
                "disabled:text-text-dimmed/50",
                isFocused && "placeholder:text-text-dimmed/70"
              )}
              containerClassName="has-[:disabled]:opacity-100"
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim() && !isLoading) {
                  e.preventDefault();
                  const form = e.currentTarget.closest("form");
                  if (form) {
                    form.requestSubmit();
                  }
                }
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => {
                // Only blur if the text is empty or we're not loading
                if (text.length === 0 || !isLoading) {
                  setIsFocused(false);
                }
              }}
              icon={<AISparkleIcon className="size-4" />}
              accessory={
                isLoading ? (
                  <Spinner
                    color={{
                      background: "rgba(99, 102, 241, 1)",
                      foreground: "rgba(217, 70, 239, 1)",
                    }}
                    className="size-4 opacity-80"
                  />
                ) : text.length > 0 ? (
                  <ShortcutKey
                    shortcut={{ key: "enter" }}
                    variant="small"
                    className={cn("transition-opacity", text.length === 0 && "opacity-0")}
                  />
                ) : undefined
              }
            />
          </div>
        </motion.div>
      </ErrorPopover>
    </fetcher.Form>
  );
}

function ErrorPopover({
  children,
  error,
  durationMs = 10_000,
}: {
  children: React.ReactNode;
  error?: string;
  durationMs?: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const timeout = useRef<NodeJS.Timeout | undefined>();

  useEffect(() => {
    if (error) {
      setIsOpen(true);
    }
    if (timeout.current) {
      clearTimeout(timeout.current);
    }
    timeout.current = setTimeout(() => {
      setIsOpen(false);
    }, durationMs);

    return () => {
      if (timeout.current) {
        clearTimeout(timeout.current);
      }
    };
  }, [error, durationMs]);

  return (
    <Popover open={isOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-trigger-width)] border border-error/20 bg-[#2F1D24] px-3 py-2 text-xs text-text-dimmed"
      >
        {error}
      </PopoverContent>
    </Popover>
  );
}

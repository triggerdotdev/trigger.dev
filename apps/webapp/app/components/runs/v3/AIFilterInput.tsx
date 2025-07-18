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
import { motion } from "framer-motion";

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

  // Calculate position for error message
  const [errorPosition, setErrorPosition] = useState({ top: 0, left: 0, width: 0 });

  useEffect(() => {
    if (fetcher.data?.success === false && inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      setErrorPosition({
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
      });
    }
  }, [fetcher.data?.success]);

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
      <motion.div
        initial={{ width: "auto" }}
        animate={{ width: isFocused && text.length > 0 ? "24rem" : "auto" }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30,
        }}
        className="animated-gradient-glow relative"
      >
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
            "placeholder:text-text-bright",
            isFocused && "placeholder:text-text-dimmed"
          )}
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
              <Spinner color="muted" className="size-4" />
            ) : text.length > 0 ? (
              <ShortcutKey
                shortcut={{ key: "enter" }}
                variant="small"
                className={cn("transition-opacity", text.length === 0 && "opacity-0")}
              />
            ) : undefined
          }
        />
        {fetcher.data?.success === false && (
          <Portal>
            <div
              className="fixed z-[9999] rounded-md bg-rose-500 px-3 py-2 text-sm text-white shadow-lg"
              style={{
                top: `${errorPosition.top + 8}px`,
                left: `${errorPosition.left}px`,
                width: `${errorPosition.width}px`,
              }}
            >
              {fetcher.data.error}
            </div>
          </Portal>
        )}
      </motion.div>
    </fetcher.Form>
  );
}

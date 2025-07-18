import { useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Button } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { Spinner } from "~/components/primitives/Spinner";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { type TaskRunListSearchFilters } from "./RunFilters";
import { objectToSearchParams } from "~/utils/searchParams";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";

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
  const { replace } = useSearchParams();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const fetcher = useFetcher<AIFilterResult>();

  useEffect(() => {
    if (fetcher.data?.success) {
      const searchParams = objectToSearchParams(fetcher.data.filters);
      if (!searchParams) {
        return;
      }

      replace(searchParams);

      // Clear the input after successful application
      setText("");

      // TODO: Show success message with explanation
      console.log(`AI applied filters: ${fetcher.data.explanation}`);
    } else if (fetcher.data?.success === false) {
      // TODO: Show error with suggestions
      console.error(fetcher.data.error, fetcher.data.suggestions);
    }
  }, [fetcher.data, replace]);

  const isLoading = fetcher.state === "submitting";

  return (
    <fetcher.Form
      className="flex items-center gap-2"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/ai-filter`}
      method="post"
    >
      <div className="relative flex-1">
        <Input
          type="text"
          name="text"
          variant="small"
          placeholder="Describe your filters…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isLoading}
          className="pr-10"
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() && !isLoading) {
              e.preventDefault();
              const form = e.currentTarget.closest("form");
              if (form) {
                form.requestSubmit();
              }
            }
          }}
          icon={<AISparkleIcon className="size-4" />}
          accessory={
            text.length > 0 ? (
              <ShortcutKey shortcut={{ key: "enter" }} variant="small" />
            ) : undefined
          }
        />
        {isLoading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Spinner color="muted" />
          </div>
        )}
      </div>
    </fetcher.Form>
  );
}

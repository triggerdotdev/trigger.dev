import { SparklesIcon } from "@heroicons/react/20/solid";
import { ClipboardCheckIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button, type ButtonVariant } from "~/components/primitives/Buttons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

/**
 * Copies the endpoint's AI setup prompt. The prompt is rendered on the server (it carries the URL,
 * subscribers and secret state), so it is fetched on hover or focus and copied on click.
 */
export function CopySetupPromptButton({
  endpointFriendlyId,
  source,
  variant = "tertiary/small",
  label = "Copy setup prompt",
}: {
  endpointFriendlyId: string;
  source: string;
  variant?: ButtonVariant;
  label?: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const pending = useRef<Promise<string> | null>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const path = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
    environment.slug
  }/webhooks/endpoints/${encodeURIComponent(endpointFriendlyId)}/setup-prompt`;

  const load = useCallback(() => {
    if (!pending.current) {
      const request = fetch(path, { headers: { accept: "application/json" } })
        .then((response) => {
          if (!response.ok) throw new Error(`Setup prompt request failed: ${response.status}`);
          return response.json() as Promise<{ prompt: string }>;
        })
        .then((body) => body.prompt);
      request.catch(() => {
        pending.current = null;
      });
      pending.current = request;
    }
    return pending.current;
  }, [path]);

  const copy = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(await load());
        setState("copied");
      } catch {
        setState("failed");
      }
      pending.current = null;
      setTimeout(() => setState("idle"), 1500);
    },
    [load]
  );

  return (
    <span className="inline-flex" onPointerEnter={load} onFocusCapture={load}>
      <Button
        variant={variant}
        onClick={copy}
        LeadingIcon={
          state === "copied" ? (
            <ClipboardCheckIcon className="size-3.5 text-green-500" />
          ) : (
            <SparklesIcon className="size-3.5 text-text-dimmed" />
          )
        }
        tooltip={
          state === "copied"
            ? "Copied"
            : state === "failed"
              ? "Couldn't copy the prompt, try again"
              : `Copy a prompt for an AI agent, like Claude Code, to connect this endpoint to ${source}`
        }
      >
        {label}
      </Button>
    </span>
  );
}

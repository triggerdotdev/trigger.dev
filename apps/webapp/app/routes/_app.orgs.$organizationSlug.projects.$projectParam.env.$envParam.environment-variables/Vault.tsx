import { PencilSquareIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { AgentVaultIcon } from "~/assets/icons/AgentVaultIcon";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher } from "@remix-run/react";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { TextLink } from "~/components/primitives/TextLink";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { docsPath } from "~/utils/pathBuilder";
import { cn } from "~/utils/cn";
import {
  useEnvironmentVariablesActionPath,
  type MaskedEnvironmentVariable,
} from "./EnvironmentVariableControls";

/**
 * Shown while Vault can be enabled, and after. The enable button goes once Vault is on; platform
 * admins get a disable button, refused while the project has Vault values.
 */
export function VaultBanner({
  enabled,
  disable,
}: {
  enabled: boolean;
  disable?: { blocked: boolean } | null;
}) {
  return (
    <Callout
      variant="docs"
      icon={<AgentVaultIcon className="mt-0.5 size-5 shrink-0 text-callout-docs" />}
      className="mx-2 mt-2 w-auto items-end"
      cta={
        enabled ? (
          disable && <DisableVaultButton blocked={disable.blocked} />
        ) : (
          <EnableVaultButton />
        )
      }
    >
      <div className="text-sm">
        <strong>Agent Vault{enabled && " is enabled"}</strong>
        <p className="text-text-dimmed">
          Restrict secrets to specific domains at runtime.{" "}
          <TextLink href={docsPath("vault")} target="_blank" rel="noreferrer">
            Read the docs
          </TextLink>
        </p>
      </div>
    </Callout>
  );
}

function EnableVaultButton() {
  const fetcher = useFetcher<{ success?: boolean }>();
  const actionPath = useEnvironmentVariablesActionPath();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- Closes once Vault is on.
      setIsOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary/small" className="shrink-0">
          Enable Agent Vault
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Enable Agent Vault</DialogHeader>
        <div className="mt-3 grid gap-3 text-sm">
          <Paragraph variant="small">Enabling Agent Vault for this project means:</Paragraph>
          <ul className="list-disc space-y-1 pl-5 text-text-dimmed">
            <li>
              All new runs in this project's deployed environments will run on our Firecracker
              infrastructure.
            </li>
            <li>Those runs will be connected to the new Agent Vault system.</li>
            <li>
              Only secrets you explicitly add to the Vault change behavior. Other environment
              variables work as before.
            </li>
          </ul>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="tertiary/small">Cancel</Button>
          </DialogClose>
          <fetcher.Form method="post" action={actionPath}>
            <Button
              type="submit"
              name="action"
              value="enable-vault"
              variant="primary/small"
              disabled={fetcher.state !== "idle"}
            >
              Enable Agent Vault
            </Button>
          </fetcher.Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MAX_DOMAINS = 64;
const vaultPillClassName =
  "inline-flex h-6 items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 font-mono text-xs text-indigo-300";

export function VaultDomain({ host }: { host: string }) {
  return (
    <span className={cn(vaultPillClassName, "max-w-full")}>
      <AgentVaultIcon className="size-3 shrink-0" />
      <span className="truncate">{host}</span>
    </span>
  );
}

export function VaultDomains({ hosts }: { hosts: string[] }) {
  const [first, ...rest] = hosts;
  if (!first) return null;
  const pill = (
    <span className={cn(vaultPillClassName, "ml-2 max-w-full align-middle")}>
      <AgentVaultIcon className="size-3 shrink-0" />
      <span className="truncate">{first}</span>
      {rest.length > 0 && <span className="text-indigo-400">+{rest.length}</span>}
    </span>
  );
  return rest.length ? (
    <SimpleTooltip
      button={pill}
      content={
        <ul className="font-mono text-xs">
          {hosts.map((host) => (
            <li key={host}>{host}</li>
          ))}
        </ul>
      }
    />
  ) : (
    pill
  );
}

export function SealedInVault() {
  return (
    <div className="flex items-center gap-x-1">
      <AgentVaultIcon className="size-3 shrink-0 text-indigo-500" />
      <span className="text-xs text-text-dimmed">Sealed in Agent Vault</span>
    </div>
  );
}

export function DomainInput({
  domains,
  onChange,
}: {
  domains: string[];
  onChange: (domains: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (text: string) => {
    const added = text
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((domain) => domain && !domains.includes(domain));
    if (added.length) onChange([...new Set([...domains, ...added])].slice(0, MAX_DOMAINS));
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const hasDraft = draft.trim() !== "";
    if ((event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) && hasDraft) {
      event.preventDefault();
      add(draft);
    } else if (event.key === "Enter") {
      event.preventDefault();
    } else if (event.key === "Backspace" && draft === "" && domains.length) {
      event.preventDefault();
      onChange(domains.slice(0, -1));
    }
  };

  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="vault-domains">Allowed domains</Label>
        <span className="hidden items-center whitespace-nowrap text-xs text-text-dimmed sm:flex">
          <span className="sr-only">Press Enter or Tab to add</span>
          <span aria-hidden="true" className="flex items-center">
            Press
            <ShortcutKey shortcut={{ key: "enter" }} variant="small" className="mr-1" />
            or
            <ShortcutKey shortcut={{ key: "tab" }} variant="small" className="mr-1 capitalize" />
            to add
          </span>
        </span>
      </div>
      <input type="hidden" name="domains" value={domains.join(",")} />
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Clicking the empty space focuses the input; keyboard users tab to it. */}
      <div
        className="flex min-h-9 cursor-text flex-wrap items-center gap-1 rounded border border-border-bright/50 bg-input-bg p-1 shadow-xs transition has-[input:focus]:ring-1 has-[input:focus]:ring-border-bright"
        onClick={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
      >
        {domains.map((domain) => (
          <span
            key={domain}
            className={cn(vaultPillClassName, "h-7 min-w-0 max-w-full gap-0.5 pr-0.5 text-sm")}
          >
            <span className="min-w-0 truncate">{domain}</span>
            <button
              type="button"
              aria-label={`Remove ${domain}`}
              onClick={() => {
                onChange(domains.filter((item) => item !== domain));
                inputRef.current?.focus();
              }}
              className="flex size-6 flex-none items-center justify-center rounded-full outline-none transition hover:bg-indigo-500/20 focus-visible:ring-1 focus-visible:ring-indigo-500"
            >
              <XMarkIcon className="size-4" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id="vault-domains"
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            // A space or comma ends a domain; whatever follows it stays in the input.
            if (!/[\s,]/.test(value)) return setDraft(value);
            const parts = value.split(/[\s,]+/);
            const rest = parts.pop() ?? "";
            add(parts.join(" "));
            setDraft(rest);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!/[\s,]/.test(text.trim())) return;
            event.preventDefault();
            add(`${draft} ${text}`);
          }}
          onBlur={() => add(draft)}
          placeholder={domains.length ? undefined : "api.example.com"}
          spellCheck={false}
          autoComplete="off"
          disabled={domains.length >= MAX_DOMAINS}
          className="h-7 min-w-[10rem] flex-1 border-none bg-transparent px-1 py-0 font-mono text-sm text-text-bright outline-none placeholder:text-text-dimmed focus:ring-0"
        />
      </div>
    </div>
  );
}

/** Platform admins only. Turning Vault off is refused while the project has Vault values. */
function DisableVaultButton({ blocked }: { blocked: boolean }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useFetcher<{ error?: string }>();
  return (
    <fetcher.Form
      method="post"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/vault/disable`}
      className="flex shrink-0"
    >
      <Button
        type="submit"
        variant="secondary/small"
        disabled={blocked || fetcher.state !== "idle"}
        tooltip={
          fetcher.data?.error ??
          (blocked
            ? "Delete this project's Agent Vault values before disabling Agent Vault."
            : "Admin only. Turns Agent Vault off for this project.")
        }
      >
        Disable Agent Vault
      </Button>
    </fetcher.Form>
  );
}

export function EditVaultValueButton({ variable }: { variable: MaskedEnvironmentVariable }) {
  return (
    <VaultValueDialog
      variable={variable}
      trigger={
        <Button
          variant="small-menu-item"
          LeadingIcon={PencilSquareIcon}
          fullWidth
          textAlignLeft
          aria-label={`Edit ${variable.key} in Agent Vault`}
        />
      }
    />
  );
}

/**
 * Takes a value out of Vault, behind a confirmation: runs already using it lose access to it, so
 * it should be rare.
 */
function RemoveFromVaultButton({
  variable,
  onRemoved,
}: {
  variable: MaskedEnvironmentVariable;
  onRemoved: () => void;
}) {
  const actionPath = useEnvironmentVariablesActionPath();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- Closes once the removal went through.
      setIsOpen(false);
      onRemoved();
    }
  }, [fetcher.state, fetcher.data, onRemoved]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="tertiary/small">
          Remove from Agent Vault
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Remove {variable.key} from Agent Vault?</DialogHeader>
        <div className="mt-3 grid gap-3 text-sm">
          <Callout variant="error">
            <Paragraph variant="small" className="font-normal text-callout-error-text">
              Running tasks already using this value will fail to reach the allowed domains.
            </Paragraph>
          </Callout>
          <ul className="list-disc space-y-1 pl-5 text-text-dimmed">
            <li>The value stays secret in the dashboard.</li>
            <li>
              New runs get it as an ordinary environment variable, readable by your task code and
              sent to any domain.
            </li>
            <li>The domain restriction is removed.</li>
          </ul>
          {fetcher.data?.error && (
            <p role="alert" className="text-error">
              {fetcher.data.error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="primary/small">Keep in Agent Vault</Button>
          </DialogClose>
          <Button
            variant="danger/small"
            disabled={fetcher.state !== "idle"}
            onClick={() =>
              fetcher.submit(
                {
                  action: "remove-from-vault",
                  id: variable.id,
                  environmentId: variable.environment.id,
                },
                { method: "post", action: actionPath }
              )
            }
          >
            Remove from Agent Vault
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Moves a value into Agent Vault, or edits a Vault value's domains and value. */
export function VaultValueDialog({
  variable,
  trigger,
}: {
  variable: MaskedEnvironmentVariable;
  trigger: ReactNode;
}) {
  const isVault = variable.vaultHosts !== undefined;
  const actionPath = useEnvironmentVariablesActionPath();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [isOpen, setIsOpen] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- Closes once the save went through.
      setIsOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) setDomains(variable.vaultConfiguredHosts ?? variable.vaultHosts ?? []);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent closeOnOutsideClick={false}>
        <DialogHeader>{isVault ? "Edit Agent Vault value" : "Move to Agent Vault"}</DialogHeader>
        <fetcher.Form className="mt-3 grid gap-4 text-sm" method="post" action={actionPath}>
          <input type="hidden" name="action" value="save-vault" />
          <input type="hidden" name="id" value={variable.id} />
          <input type="hidden" name="environmentId" value={variable.environment.id} />
          {isVault ? (
            <div className="grid gap-1">
              <Label htmlFor="vault-value">Value</Label>
              <Input
                id="vault-value"
                name="value"
                type="password"
                autoComplete="new-password"
                placeholder="Leave empty to keep the current value"
                fullWidth
              />
            </div>
          ) : (
            <p>
              From now on, <strong>{variable.key}</strong> will only be available via Agent Vault
              requests to the domains below.
            </p>
          )}
          <DomainInput domains={domains} onChange={setDomains} />
          {!isVault && (
            <Callout variant="warning">
              <Paragraph variant="small" className="font-normal text-callout-warning-text">
                This value won’t be available during builds or readable after sealing. Runs that
                already started will not lose access. Rotate the credential after moving if needed.
              </Paragraph>
            </Callout>
          )}
          {fetcher.data?.error && (
            <p role="alert" className="text-error">
              {fetcher.data.error}
            </p>
          )}
          <DialogFooter>
            {isVault ? (
              // Only a value in Vault itself, and not also through its Preview value: that one
              // has to leave first.
              variable.vaultConfiguredHosts && !variable.vaultInherited ? (
                <RemoveFromVaultButton variable={variable} onRemoved={() => setIsOpen(false)} />
              ) : (
                <span />
              )
            ) : (
              <DialogClose asChild>
                <Button type="button" variant="tertiary/medium">
                  Cancel
                </Button>
              </DialogClose>
            )}
            <Button
              type="submit"
              variant={isVault ? "primary/small" : "primary/medium"}
              disabled={!domains.length || fetcher.state !== "idle"}
            >
              {isVault ? "Save" : "Move to Agent Vault"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

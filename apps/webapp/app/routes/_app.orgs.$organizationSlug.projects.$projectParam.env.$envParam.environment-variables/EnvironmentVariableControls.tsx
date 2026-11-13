import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import {
  LockClosedIcon,
  MinusCircleIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher, useLocation, useParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import type {
  EnvironmentVariablesPresenter,
  EnvironmentVariableWithSetValues,
} from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import type { EnvironmentVariablesEnvironment } from "~/presenters/v3/environmentVariablesEnvironments.server";
import { v3EnvironmentVariablesPath } from "~/utils/pathBuilder";
import type { EnvironmentVariablesFilter } from "~/v3/environmentVariables/environmentFilter";
import { parseEnvironmentVariableForm } from "~/v3/environmentVariables/forms";
import {
  deleteValueDialog,
  type PreviewBaseState,
} from "~/v3/environmentVariables/environmentVariableKey";
import {
  DeleteEnvironmentVariableValue,
  EditEnvironmentVariableValue,
} from "~/v3/environmentVariables/repository";

// What the environment variables list and the key panel share: the page's loader data, the
// action's form schema, and the value, edit and delete controls for one value.

export type PageVercelIntegration = NonNullable<
  Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>["vercelIntegration"]
>;

// A value the current role can't read for its environment tier is masked
// server-side: the value is withheld and the cell renders "Permission denied".
export type MaskedEnvironmentVariable = EnvironmentVariableWithSetValues & {
  permissionDenied?: boolean;
};

export type EnvironmentVariablesPageLoaderData = {
  allowEmptyEnvironmentVariableValues: boolean;
  environmentVariables: MaskedEnvironmentVariable[];
  environments: EnvironmentVariablesEnvironment[];
  // The environment filter in effect, and the environments it lists.
  filter: EnvironmentVariablesFilter;
  filterEnvironmentIds: string[];
  // The preview branches the list is narrowed to. Empty when it lists every branch.
  filterBranchEnvironmentIds: string[];
  // True when no listed environment has a variable, whatever the filter is.
  projectHasNoVariables: boolean;
  hasStaging: boolean;
  vercelIntegration: PageVercelIntegration | null;
  // Environment ids whose env vars the current role can read.
  accessibleEnvironmentIds: string[];
  // Environment ids whose env vars the current role can write (create/edit/delete).
  writableEnvironmentIds: string[];
  pagination: { currentPage: number; totalPages: number; totalCount: number };
  search?: string;
};

export const environmentVariablesRouteId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables";

export const environmentVariableKeyRouteId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.key.$keyParam";

/**
 * Withholds a value (and its "who/when" metadata) the current role can't read, so it is never
 * serialized to the client.
 */
export function maskEnvironmentVariable(
  variable: EnvironmentVariableWithSetValues
): MaskedEnvironmentVariable {
  return {
    ...variable,
    value: "",
    isSecret: false,
    permissionDenied: true,
    lastUpdatedBy: null,
    updatedByUser: null,
  };
}

/** The list page's loader data, from anywhere under the list route. */
function useEnvironmentVariablesPageData() {
  return useTypedMatchesData<EnvironmentVariablesPageLoaderData>({
    id: environmentVariablesRouteId,
  });
}

/**
 * Where the value forms post: the list route, which owns the action, with the current search
 * params so the action can send the user back to the same view.
 */
export function useEnvironmentVariablesActionPath() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();

  return `${v3EnvironmentVariablesPath(organization, project, environment)}${location.search}`;
}

export const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), ...EditEnvironmentVariableValue.shape }),
  z.object({
    action: z.literal("delete"),
    key: z.string(),
    // The key open in the key panel when the delete was made, to return to it.
    panelKey: z.string().optional(),
    ...DeleteEnvironmentVariableValue.shape,
  }),
  z.object({
    action: z.literal("update-vercel-sync"),
    key: z.string(),
    environmentType: z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]),
    syncEnabled: z
      .union([z.literal("true"), z.literal("false")])
      .transform((val) => val === "true"),
  }),
]);

/**
 * A value as the list shows it: masked with copy, Secret, Empty, Permission denied or Encryption
 * key unavailable.
 */
export function EnvironmentVariableValue({
  variable,
  revealAll,
}: {
  variable: MaskedEnvironmentVariable;
  revealAll: boolean;
}) {
  return variable.permissionDenied ? (
    <SimpleTooltip
      button={
        <div className="flex items-center gap-x-1">
          <NoSymbolIcon className="size-3 text-text-dimmed" />
          <span className="text-xs text-text-dimmed">Permission denied</span>
        </div>
      }
      content="With your current role, you can't view this environment's variables."
    />
  ) : variable.valueUnavailable ? (
    <span className="text-xs text-text-dimmed">Encryption key unavailable</span>
  ) : variable.isSecret ? (
    <SimpleTooltip
      button={
        <div className="flex items-center gap-x-1">
          <LockClosedIcon className="size-3 text-text-dimmed" />
          <span className="text-xs text-text-dimmed">Secret</span>
        </div>
      }
      content="This variable is secret and cannot be revealed."
    />
  ) : variable.value === "" ? (
    <SimpleTooltip
      button={
        <div className="flex items-center gap-x-1">
          <MinusCircleIcon className="size-3 text-text-dimmed" />
          <span className="text-xs text-text-dimmed">Empty</span>
        </div>
      }
      content="This variable is set to an empty string."
    />
  ) : (
    <ClipboardField
      secure={!revealAll}
      value={variable.value}
      variant={"secondary/small"}
      fullWidth={true}
    />
  );
}

/** When a value was last updated, and by whom. */
export function EnvironmentVariableUpdated({ variable }: { variable: MaskedEnvironmentVariable }) {
  return (
    <div className="flex items-center gap-3">
      {variable.updatedAt ? (
        <span className="shrink-0 text-sm tabular-nums text-text-dimmed">
          <DateTime date={variable.updatedAt} includeSeconds={false} />
        </span>
      ) : null}
      {variable.updatedByUser ? (
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar
            avatarUrl={variable.updatedByUser.avatarUrl}
            name={variable.updatedByUser.name}
            className="size-5 shrink-0"
          />
          <span className="truncate text-sm">{variable.updatedByUser.name}</span>
        </div>
      ) : variable.lastUpdatedBy?.type === "integration" &&
        variable.lastUpdatedBy?.integration === "vercel" ? (
        <div className="flex min-w-0 items-center gap-2">
          <VercelLogo className="size-4 shrink-0 text-text-dimmed transition-colors group-hover/table-row:text-text-bright" />
          <span className="truncate text-sm capitalize text-text-dimmed transition-colors group-hover/table-row:text-text-bright">
            {variable.lastUpdatedBy.integration}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function EditEnvironmentVariablePanel({
  variable,
  revealAll,
}: {
  variable: EnvironmentVariableWithSetValues;
  revealAll: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const allowEmptyEnvironmentVariableValues =
    useEnvironmentVariablesPageData()?.allowEmptyEnvironmentVariableValues ?? false;
  const actionPath = useEnvironmentVariablesActionPath();
  const [emptyValueSelected, setEmptyValueSelected] = useState(false);
  const [draftValue, setDraftValue] = useState(variable.value);
  const valueInputRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher();
  const lastSubmission = fetcher.data as any;

  const isLoading = fetcher.state !== "idle";

  // Close dialog on successful submission
  useEffect(() => {
    if (lastSubmission?.success && fetcher.state === "idle") {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setIsOpen(false);
    }
  }, [lastSubmission?.success, fetcher.state]);

  const [form, { id, environmentId, value }] = useForm({
    id: `edit-environment-variable-${variable.id}-${variable.environment.id}`,
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseEnvironmentVariableForm(formData, schema, allowEmptyEnvironmentVariableValues);
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) {
          setEmptyValueSelected(false);
          setDraftValue(variable.value);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={PencilSquareIcon}
          fullWidth
          textAlignLeft
          aria-label="Edit"
        />
      </DialogTrigger>
      <DialogContent
        // Start in the value, selected, so typing replaces it and never reaches page shortcuts.
        // A secret's value isn't shown, so its field starts empty.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          valueInputRef.current?.focus();
          valueInputRef.current?.select();
        }}
      >
        <DialogHeader>Edit environment variable</DialogHeader>
        <fetcher.Form method="post" action={actionPath} {...getFormProps(form)}>
          <input type="hidden" name="action" value="edit" />
          <input {...getInputProps(id, { type: "hidden" })} value={variable.id} />
          <input
            {...getInputProps(environmentId, { type: "hidden" })}
            value={variable.environment.id}
          />
          <FormError id={id.errorId}>{id.errors}</FormError>
          <FormError id={environmentId.errorId}>{environmentId.errors}</FormError>
          <Fieldset>
            <InputGroup fullWidth className="mt-2 gap-0">
              <Label>Key</Label>
              <CopyableText value={variable.key} className="w-fit font-mono text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Environment</Label>
              <EnvironmentCombo environment={variable.environment} className="text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Value</Label>
              <Input
                {...getInputProps(value, { type: "text", value: false })}
                ref={valueInputRef}
                placeholder={variable.isSecret ? "Set new secret value" : "Not set"}
                value={emptyValueSelected ? "" : draftValue}
                onChange={(event) => setDraftValue(event.currentTarget.value)}
                disabled={emptyValueSelected}
                type={"text"}
                autoComplete="off"
              />
              {emptyValueSelected && <input type="hidden" name={value.name} value="" />}
              <FormError id={value.errorId}>{value.errors}</FormError>
              {variable.isSecret && allowEmptyEnvironmentVariableValues && (
                <CheckboxWithLabel
                  name="setEmptyValue"
                  value="true"
                  variant="description"
                  label="Set to an empty string"
                  description="Replaces the secret with an empty string and keeps the variable."
                  onChange={setEmptyValueSelected}
                />
              )}
            </InputGroup>

            <FormError>{form.errors}</FormError>

            <FormButtons
              confirmButton={
                <Button type="submit" variant="primary/medium" disabled={isLoading}>
                  {isLoading ? "Saving…" : "Save"}
                </Button>
              }
              cancelButton={
                <Button onClick={() => setIsOpen(false)} variant="tertiary/medium" type="button">
                  Cancel
                </Button>
              }
            />
          </Fieldset>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteEnvironmentVariableButton({
  variable,
  previewBase = "unknown",
}: {
  variable: EnvironmentVariableWithSetValues;
  /** For a Preview branch's value: whether the key has a Preview value to fall back to. */
  previewBase?: PreviewBaseState;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dialog = deleteValueDialog(variable.environment, previewBase);
  const isOverride = dialog.kind === "removeOverride";
  // Danger only when the value goes away for good: a branch that falls back to the Preview
  // value (or might) still has one.
  const isDestructive = dialog.kind === "delete" || dialog.afterRemoval === "noValue";
  // A fetcher, not a navigation: the form posts to the list route from the key panel too, and
  // an error has to come back to this dialog instead of closing the panel.
  const fetcher = useFetcher();
  const lastSubmission = fetcher.data;
  const actionPath = useEnvironmentVariablesActionPath();
  // The key open in the panel, if any, so the action can keep the panel open.
  const { keyParam } = useParams();
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const isLoading = fetcher.state !== "idle";

  const [form] = useForm({
    id: `delete-environment-variable-${variable.id}-${variable.environment.id}`,
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseEnvironmentVariableForm(formData, schema);
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          fullWidth
          textAlignLeft
          LeadingIcon={TrashIcon}
          leadingIconClassName="text-rose-500 group-hover/button:text-white dark:group-hover/button:text-text-bright transition-colors"
          className="ml-0.5 transition-colors group-hover/button:bg-error"
          aria-label={isOverride ? "Remove override" : "Delete"}
          tooltip={isOverride ? "Remove override" : undefined}
        />
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        // Start on Delete, so Enter confirms. Enter on Cancel or the close button does what that
        // button says, because the shortcut below only labels the key and never fires by itself.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          deleteButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          {isOverride ? "Remove branch override" : "Delete environment variable"}
        </DialogHeader>
        <div className="mb-2 mt-4 flex flex-col gap-3">
          {dialog.kind === "removeOverride" ? (
            <Paragraph>
              Remove the override for <strong className="font-mono">{variable.key}</strong> on this
              branch?
              {dialog.afterRemoval === "previewValue" &&
                " The branch will use the Preview value again."}
              {dialog.afterRemoval === "noValue" && (
                <>
                  {" "}
                  The branch will have no value for{" "}
                  <strong className="font-mono">{variable.key}</strong>.
                </>
              )}
            </Paragraph>
          ) : (
            <Paragraph>
              Are you sure you want to delete <strong className="font-mono">{variable.key}</strong>{" "}
              from this environment? This can't be undone.
            </Paragraph>
          )}
          <EnvironmentCombo environment={variable.environment} className="text-sm" />
          <FormError>{form.errors}</FormError>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary/medium">Cancel</Button>
          </DialogClose>
          <fetcher.Form method="post" action={actionPath} {...getFormProps(form)}>
            {keyParam && <input type="hidden" name="panelKey" value={keyParam} />}
            <input type="hidden" name="id" value={variable.id} />
            <input type="hidden" name="key" value={variable.key} />
            <input type="hidden" name="environmentId" value={variable.environment.id} />
            <Button
              ref={deleteButtonRef}
              name="action"
              value="delete"
              type="submit"
              variant={isDestructive ? "danger/medium" : "primary/medium"}
              LeadingIcon={TrashIcon}
              disabled={isLoading}
              shortcut={{ key: "enter", enabled: false }}
            >
              {isOverride
                ? isLoading
                  ? "Removing…"
                  : "Remove override"
                : isLoading
                  ? "Deleting…"
                  : "Delete"}
            </Button>
          </fetcher.Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What an inline value editor saves: a new value for a set value, or the first one for a key. */
export type InlineValueTarget =
  | { kind: "edit"; variable: EnvironmentVariableWithSetValues }
  | {
      kind: "set";
      key: string;
      environment: Pick<
        EnvironmentVariableWithSetValues["environment"],
        "id" | "type" | "branchName"
      >;
      /** The create action to post to (the key panel's create route). */
      actionPath: string;
    };

/**
 * A value edited in place, as the key panel shows it: an input with Save and Cancel. Posts the
 * same actions as the dialogs (edit, or create for one environment) and shows their errors under
 * the input. Enter saves; Escape cancels.
 */
export function InlineValueEditor({
  target,
  onDone,
}: {
  target: InlineValueTarget;
  /** Called after a save went through, or on cancel. */
  onDone: () => void;
}) {
  const allowEmptyEnvironmentVariableValues =
    useEnvironmentVariablesPageData()?.allowEmptyEnvironmentVariableValues ?? false;
  const editActionPath = useEnvironmentVariablesActionPath();
  const fetcher = useFetcher();
  const isSecret = target.kind === "edit" && target.variable.isSecret;
  const [draft, setDraft] = useState(
    target.kind === "edit" && !isSecret ? target.variable.value : ""
  );
  const [emptyValueSelected, setEmptyValueSelected] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // The fetcher's data when the save was sent, to tell a new reply from an old one. A create
  // that goes through redirects, which leaves the data as it was.
  const submittedRef = useRef<{ data: unknown } | null>(null);

  const key = target.kind === "edit" ? target.variable.key : target.key;
  const environment = target.kind === "edit" ? target.variable.environment : target.environment;
  const errorId = `inline-value-error-${environment.id}`;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const submitted = submittedRef.current;
    if (fetcher.state !== "idle" || !submitted) {
      return;
    }
    submittedRef.current = null;
    const replyErrors = fetcher.data !== submitted.data ? submissionErrors(fetcher.data) : [];
    if (replyErrors.length > 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- Shows the action's reply once it arrives.
      setErrors(replyErrors);
      inputRef.current?.focus();
    } else {
      onDone();
    }
  }, [fetcher.state, fetcher.data, onDone]);

  const save = () => {
    const formData = new FormData();
    const value = emptyValueSelected ? "" : draft;
    if (target.kind === "edit") {
      formData.set("action", "edit");
      formData.set("id", target.variable.id);
      formData.set("environmentId", target.variable.environment.id);
      formData.set("value", value);
      if (emptyValueSelected) {
        formData.set("setEmptyValue", "true");
      }
      const submission = parseEnvironmentVariableForm(
        formData,
        schema,
        allowEmptyEnvironmentVariableValues
      );
      if (submission.status !== "success") {
        setErrors(submissionErrors(submission.reply()));
        return;
      }
    } else {
      formData.set("override", "false");
      formData.set("isSecret", "false");
      formData.set("environmentIds", target.environment.id);
      formData.set("variables[0].key", target.key);
      formData.set("variables[0].value", value);
    }
    setErrors([]);
    submittedRef.current = { data: fetcher.data };
    fetcher.submit(formData, {
      method: "post",
      action: target.kind === "edit" ? editActionPath : target.actionPath,
    });
  };

  const isSaving = fetcher.state !== "idle";

  return (
    <form
      className="flex w-full flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          variant="small"
          fullWidth
          className="font-mono"
          aria-label={`${key} in ${environmentFullTitle(environment)}`}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={errors.length > 0 ? errorId : undefined}
          placeholder={isSecret ? "Set new secret value" : "Not set"}
          value={emptyValueSelected ? "" : draft}
          disabled={emptyValueSelected}
          autoComplete="off"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onDone();
            }
          }}
        />
        <Button type="submit" variant="primary/small" disabled={isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="tertiary/small" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {isSecret && allowEmptyEnvironmentVariableValues && (
        <CheckboxWithLabel
          variant="simple/small"
          label="Set to an empty string"
          onChange={setEmptyValueSelected}
        />
      )}
      {errors.length > 0 && <FormError id={errorId}>{errors.join(" ")}</FormError>}
    </form>
  );
}

/** The messages in a form reply (conform's `reply()`), field errors included. */
function submissionErrors(reply: unknown): string[] {
  if (typeof reply !== "object" || reply === null || !("error" in reply)) {
    return [];
  }
  const error = (reply as { error?: Record<string, string[] | null> | null }).error;
  return Object.values(error ?? {}).flatMap((messages) => messages ?? []);
}

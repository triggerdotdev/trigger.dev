import { getFormProps, getInputProps, useForm, type FieldMetadata } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import {
  MAX_TRUSTED_DEPLOY_CLAIMS,
  TrustedDeployPolicy,
  TrustedDeployScope,
  type RuntimeEnvironmentType,
} from "@trigger.dev/core/v3";
import { GitBranchIcon, TagIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { InlineCode } from "~/components/code/InlineCode";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  SETTINGS_ROW_TITLE_GAP,
  SettingsActions,
  SettingsAlertRow,
  SettingsBlock,
  SettingsRow,
  SettingsRowDescription,
  SettingsRowTitle,
} from "~/components/primitives/SettingsLayout";
import { TextLink } from "~/components/primitives/TextLink";
import { docsPath } from "~/utils/pathBuilder";
import {
  ClaimRow,
  EnvironmentFormSchema,
  RepositoryFormSchema,
  type SettingsActionData,
} from "./schemas";

/** Right-hand control column, matching the build settings rows. */
function SettingsControl({ children }: { children: ReactNode }) {
  return <div className="flex w-64 flex-col gap-1">{children}</div>;
}

function TextFieldRow({
  field,
  title,
  description,
  placeholder,
}: {
  field: FieldMetadata<string | undefined>;
  title: string;
  description: ReactNode;
  placeholder?: string;
}) {
  return (
    <SettingsRow
      align="start"
      htmlFor={field.id}
      title={title}
      description={description}
      action={
        <SettingsControl>
          <Input
            {...getInputProps(field, { type: "text" })}
            variant="medium"
            placeholder={placeholder}
          />
          <FormError id={field.errorId}>{field.errors}</FormError>
        </SettingsControl>
      }
    />
  );
}

function identityValue(name: string, id?: string | null) {
  return id ? `${name}@${id}` : name;
}

const pinningDocsPath = docsPath("deployment/trusted-publishing#pin-github-identities");

type RepositoryIdentity = {
  repositoryOwner: string;
  repositoryName: string;
  repositoryId?: string | null;
  repositoryOwnerId?: string | null;
};

export function RepositoryForm({
  repository,
  canManage,
}: {
  repository: RepositoryIdentity | null;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const lastSubmission = useActionData<SettingsActionData>();
  const navigation = useNavigation();
  const [form, fields] = useForm({
    id: "trusted-repository",
    lastResult: lastSubmission?.formId === "repository" ? lastSubmission.result : undefined,
    defaultValue: {
      repositoryOwner: repository
        ? identityValue(repository.repositoryOwner, repository.repositoryOwnerId)
        : "",
      repositoryName: repository
        ? identityValue(repository.repositoryName, repository.repositoryId)
        : "",
    },
    onValidate: ({ formData }) => parseWithZod(formData, { schema: RepositoryFormSchema }),
  });

  const showPinningHint =
    !/@\d+$/.test(fields.repositoryOwner.value ?? "") &&
    !/@\d+$/.test(fields.repositoryName.value ?? "");

  if (repository && !editing) {
    const { repositoryOwner, repositoryName } = repository;
    return (
      <SettingsRow
        action={
          canManage ? (
            <div className="flex gap-2">
              <Button type="button" variant="secondary/small" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Form method="post">
                <Button
                  type="submit"
                  name="intent"
                  value="delete-repository"
                  variant="tertiary/small"
                  disabled={navigation.state !== "idle"}
                >
                  Delete
                </Button>
              </Form>
            </div>
          ) : undefined
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <OctoKitty className="size-4 shrink-0 text-text-bright" />
          <SettingsRowTitle className="min-w-0 gap-1.5">
            <TextLink
              href={`https://github.com/${repositoryOwner}`}
              title={repositoryOwner}
              className="min-w-0 max-w-[40%]"
              target="_blank"
              rel="noreferrer"
            >
              <span className="truncate">{repositoryOwner}</span>
            </TextLink>
            <span className="shrink-0 text-text-faint">/</span>
            <TextLink
              href={`https://github.com/${repositoryOwner}/${repositoryName}`}
              title={repositoryName}
              className="min-w-0"
              target="_blank"
              rel="noreferrer"
            >
              <span className="truncate">{repositoryName}</span>
            </TextLink>
          </SettingsRowTitle>
        </div>
      </SettingsRow>
    );
  }

  return (
    <Form method="post" {...getFormProps(form)}>
      <input type="hidden" name="intent" value="repository" />
      <fieldset disabled={!canManage || navigation.state !== "idle"} className="min-w-0">
        <TextFieldRow
          field={fields.repositoryOwner}
          title="Organization or user"
          description="The GitHub account that owns the repository."
          placeholder="my-org"
        />
        <TextFieldRow
          field={fields.repositoryName}
          title="Repository"
          description="The repository whose workflows will deploy."
          placeholder="my-project"
        />
        {showPinningHint && (
          <SettingsBlock size="sm">
            <SettingsRowDescription>
              Add numeric GitHub IDs, like{" "}
              <InlineCode variant="extra-small">my-org@12345</InlineCode>, so a renamed or
              transferred repository can't inherit this trust.{" "}
              <TextLink href={pinningDocsPath} target="_blank" rel="noreferrer">
                Find your IDs
              </TextLink>
            </SettingsRowDescription>
          </SettingsBlock>
        )}
        <FormError>{form.errors}</FormError>
        <SettingsActions>
          {repository && (
            <Button
              type="button"
              variant="tertiary/small"
              onClick={() => {
                form.reset();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary/small">
            Save
          </Button>
        </SettingsActions>
      </fieldset>
    </Form>
  );
}

const scopeOptions = [
  { value: "ANY", label: "Any branch or tag" },
  { value: "BRANCH", label: "Branch" },
  { value: "TAG", label: "Tag" },
  { value: "ENVIRONMENT", label: "Environment" },
] as const;

const scopeDescriptions: Record<TrustedDeployPolicy["scope"], string> = {
  ANY: "Workflows on any branch or tag can deploy.",
  BRANCH: "Only workflows running on a matching branch can deploy.",
  TAG: "Only workflows running on a matching tag can deploy.",
  ENVIRONMENT: "Only jobs that use a matching GitHub Environment can deploy.",
};

function scopeLabel(scope: TrustedDeployPolicy["scope"]) {
  return scopeOptions.find((option) => option.value === scope)?.label;
}

export function EnvironmentForm({
  environment,
  environmentType,
  canManage,
  repositoryUpdatedAt,
}: {
  environment: {
    id: string;
    grant?: {
      enabled: boolean;
      scope: TrustedDeployPolicy["scope"];
      scopeValue: string | null;
      additionalClaims: unknown;
    } | null;
  };
  environmentType: RuntimeEnvironmentType;
  canManage: boolean;
  repositoryUpdatedAt: string;
}) {
  const [editing, setEditing] = useState(false);
  const lastSubmission = useActionData<SettingsActionData>();
  const navigation = useNavigation();
  const parsedPolicy = TrustedDeployPolicy.safeParse(
    environment.grant ?? {
      scope: "ANY",
      scopeValue: null,
      additionalClaims: {},
    }
  );
  const defaults = parsedPolicy.success ? parsedPolicy.data : undefined;
  const savedClaims = Object.entries(defaults?.additionalClaims ?? {});
  const [scope, setScope] = useState(defaults?.scope ?? "ANY");
  const formId = `environment-${environment.id}`;
  const [form, fields] = useForm({
    id: formId,
    lastResult: lastSubmission?.formId === formId ? lastSubmission.result : undefined,
    defaultValue: {
      repositoryUpdatedAt,
      scope: defaults?.scope ?? "ANY",
      scopeValue: defaults?.scopeValue ?? "",
      additionalClaims: savedClaims.map(([name, values]) => ({
        name,
        values: values.join(", "),
      })),
    },
    shouldValidate: "onInput",
    onValidate: ({ formData }) => parseWithZod(formData, { schema: EnvironmentFormSchema }),
  });
  const claims = fields.additionalClaims.getFieldList();
  const scopeValueLabel =
    scope === "BRANCH" ? "Branch name" : scope === "TAG" ? "Tag name" : "Environment name";
  const showScopeWarning = environmentType === "PRODUCTION" && scope === "ANY";
  const disabledAlert = environment.grant && !environment.grant.enabled && (
    <SettingsAlertRow
      variant="warning"
      title="Publishing paused"
      description="The trusted repository changed. Review and save these settings to allow publishing again."
      action={
        !editing && canManage ? (
          <Button type="button" variant="secondary/small" onClick={() => setEditing(true)}>
            Review
          </Button>
        ) : undefined
      }
    />
  );

  if (!environment.grant && !editing) {
    return (
      <SettingsRow
        title="Publishing"
        description="Let workflows in the trusted repository deploy to this environment."
        action={
          <Button
            type="button"
            variant="secondary/small"
            disabled={!repositoryUpdatedAt || !canManage || navigation.state !== "idle"}
            onClick={() => setEditing(true)}
          >
            Enable
          </Button>
        }
      />
    );
  }

  if (environment.grant && defaults && !editing) {
    return (
      <>
        {disabledAlert}
        <SettingsRow
          title="Scope by"
          description={scopeDescriptions[defaults.scope]}
          action={
            <span className="flex max-w-64 items-center gap-2 break-all text-sm text-text-bright">
              {defaults.scopeValue ? (
                <>
                  <span className="text-text-dimmed">{scopeLabel(defaults.scope)}</span>
                  <InlineCode variant="small">{defaults.scopeValue}</InlineCode>
                </>
              ) : (
                scopeLabel(defaults.scope)
              )}
            </span>
          }
        />
        <SettingsRow
          title="Additional claims"
          description="Every claim must match."
          align={savedClaims.length > 1 ? "start" : "center"}
          action={
            savedClaims.length > 0 ? (
              <div className="flex max-w-80 flex-col items-end gap-1.5 text-right">
                {savedClaims.map(([name, values]) => (
                  <span key={name} className="break-words text-sm text-text-bright">
                    <InlineCode variant="small">{name}</InlineCode>{" "}
                    <span className="text-text-dimmed">{values.join(", ")}</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-text-dimmed">None</span>
            )
          }
        />
        {canManage && (
          <SettingsActions className="items-center">
            <Button type="button" variant="secondary/small" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Form method="post">
              <Button
                type="submit"
                name="intent"
                value="delete-environment"
                variant="tertiary/small"
                disabled={navigation.state !== "idle"}
              >
                Delete
              </Button>
            </Form>
          </SettingsActions>
        )}
      </>
    );
  }

  return (
    <Form method="post" {...getFormProps(form)}>
      <input type="hidden" name="intent" value="environment" />
      <input {...getInputProps(fields.repositoryUpdatedAt, { type: "hidden" })} />
      <input type="hidden" name={fields.scope.name} value={scope} />
      <fieldset
        disabled={!repositoryUpdatedAt || !canManage || navigation.state !== "idle"}
        className="min-w-0"
      >
        {!defaults && (
          <SettingsAlertRow
            variant="error"
            title="Saved settings can't be shown"
            description="Save to replace them."
          />
        )}
        {disabledAlert}
        <SettingsRow
          align="start"
          htmlFor={fields.scope.id}
          title="Scope by"
          description={scopeDescriptions[scope]}
          bordered={!showScopeWarning}
          className={showScopeWarning ? "pb-0" : undefined}
          action={
            <SettingsControl>
              <Select<string, (typeof scopeOptions)[number]>
                id={fields.scope.id}
                value={scope}
                items={[...scopeOptions]}
                text={(value) => scopeOptions.find((option) => option.value === value)?.label}
                variant="secondary/medium"
                className="w-full justify-between"
                dropdownIcon
                setValue={(value) => {
                  const parsed = TrustedDeployScope.safeParse(value);
                  if (parsed.success) {
                    setScope(parsed.data);
                    form.update({ name: fields.scopeValue.name, value: "" });
                  }
                }}
              >
                {(items) =>
                  items.map((item) => (
                    <SelectItem key={item.value} value={item.value} checkPosition="right">
                      {item.label}
                    </SelectItem>
                  ))
                }
              </Select>
              <FormError id={fields.scope.errorId}>{fields.scope.errors}</FormError>
            </SettingsControl>
          }
        />
        {showScopeWarning && (
          <SettingsAlertRow
            variant="warning"
            title="No scope restriction"
            description="Any workflow in the repository can deploy to Production. Consider scoping by branch, tag, or environment."
          />
        )}
        {scope !== "ANY" && (
          <SettingsRow
            align="start"
            htmlFor={fields.scopeValue.id}
            title={scopeValueLabel}
            description={
              scope === "ENVIRONMENT" ? (
                <>
                  Exact name, as set with{" "}
                  <InlineCode variant="extra-small">environment:</InlineCode> on the job.
                </>
              ) : (
                <>
                  Supports <InlineCode variant="extra-small">*</InlineCode> wildcards. Leave out{" "}
                  <InlineCode variant="extra-small">
                    {scope === "TAG" ? "refs/tags/" : "refs/heads/"}
                  </InlineCode>
                  .
                </>
              )
            }
            action={
              <SettingsControl>
                <Input
                  {...getInputProps(fields.scopeValue, { type: "text" })}
                  variant="medium"
                  className="font-mono"
                  icon={scope === "BRANCH" ? GitBranchIcon : scope === "TAG" ? TagIcon : undefined}
                  placeholder={
                    scope === "ENVIRONMENT" ? "production" : scope === "TAG" ? "v*" : "main"
                  }
                />
                <FormError id={fields.scopeValue.errorId}>{fields.scopeValue.errors}</FormError>
              </SettingsControl>
            }
          />
        )}
        <SettingsBlock className="flex flex-col gap-3">
          <div className={SETTINGS_ROW_TITLE_GAP}>
            <SettingsRowTitle>Additional claims</SettingsRowTitle>
            <SettingsRowDescription>
              Restrict the scope further with GitHub OIDC token claims. Every claim must match;
              separate accepted values with commas.
            </SettingsRowDescription>
          </div>
          {claims.length > 0 && (
            <div className="space-y-2">
              {claims.map((claim, index) => {
                const row = claim.getFieldset();
                return (
                  <div
                    key={claim.key}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-start gap-2"
                  >
                    <InputGroup fullWidth>
                      <Input
                        {...getInputProps(row.name, { type: "text" })}
                        variant="medium"
                        placeholder="event_name"
                        aria-label="Claim name"
                        className="font-mono"
                      />
                      <FormError id={row.name.errorId}>{row.name.errors}</FormError>
                    </InputGroup>
                    <InputGroup fullWidth>
                      <Input
                        {...getInputProps(row.values, { type: "text" })}
                        variant="medium"
                        placeholder="push, workflow_dispatch"
                        aria-label="Accepted values"
                        className="font-mono"
                      />
                      <FormError id={row.values.errorId}>{row.values.errors}</FormError>
                    </InputGroup>
                    <Button
                      type="button"
                      variant="minimal/medium"
                      LeadingIcon={TrashIcon}
                      aria-label="Remove claim"
                      onClick={() =>
                        form.remove({
                          name: fields.additionalClaims.name,
                          index,
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
          <FormError id={fields.additionalClaims.errorId}>
            {fields.additionalClaims.errors}
          </FormError>
          <div>
            <Button
              type="button"
              variant="secondary/small"
              LeadingIcon={PlusIcon}
              disabled={claims.length >= MAX_TRUSTED_DEPLOY_CLAIMS}
              onClick={() =>
                form.insert({
                  name: fields.additionalClaims.name,
                  defaultValue: { name: "", values: "" },
                })
              }
            >
              Add claim
            </Button>
          </div>
        </SettingsBlock>
        <FormError>{form.errors}</FormError>
        <SettingsActions>
          {editing && (
            <Button
              type="button"
              variant="tertiary/small"
              onClick={() => {
                form.reset();
                setScope(defaults?.scope ?? "ANY");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            variant="primary/small"
            disabled={claims.some((claim) => !ClaimRow.safeParse(claim.value).success)}
          >
            Save
          </Button>
        </SettingsActions>
      </fieldset>
    </Form>
  );
}

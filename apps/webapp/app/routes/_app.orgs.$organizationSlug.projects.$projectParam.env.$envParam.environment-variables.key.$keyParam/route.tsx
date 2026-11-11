import { cn } from "~/utils/cn";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import {
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  type ShouldRevalidateFunction,
} from "@remix-run/react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SearchInput } from "~/components/primitives/SearchInput";
import * as Property from "~/components/primitives/PropertyTable";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import {
  EnvironmentVariableKeyPresenter,
  type EnvironmentVariableKeyDetail,
} from "~/presenters/v3/EnvironmentVariableKeyPresenter.server";
import type { EnvironmentVariableWithSetValues } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import {
  DeleteEnvironmentVariableButton,
  EnvironmentVariableUpdated,
  InlineValueEditor,
  EnvironmentVariableValue,
  environmentVariablesRouteId,
  maskEnvironmentVariable,
  type EnvironmentVariablesPageLoaderData,
  type MaskedEnvironmentVariable,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/EnvironmentVariableControls";
import type { EnvironmentVariablesOutletContext } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { pageMeta } from "~/utils/pageTitle";
import {
  EnvironmentParamSchema,
  v3EnvironmentVariableKeyPath,
  v3EnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { listViewSearch } from "~/v3/environmentVariables/environmentFilter";
import { EnvironmentVariableKey } from "~/v3/environmentVariables/repository";
import {
  activeInlineValueEdit,
  type InlineValueEdit,
  KEY_PANEL_BRANCH_PAGE_PARAM,
  KEY_PANEL_BRANCH_SEARCH_PARAM,
  NEW_VARIABLE_ENVIRONMENT_PARAM,
  NEW_VARIABLE_FILL_KEY_PARAM,
  NEW_VARIABLE_PICK_BRANCH_PARAM,
  NEW_VARIABLE_SECRET_PARAM,
  keyPanelViewSearch,
  navigationKeepsKeyPanel,
  type EnvironmentVariableKeyCounts,
} from "~/v3/environmentVariables/environmentVariableKey";

// A name that can't be a key (keys are letters, digits and underscores) is never shown back:
// the URL is the only place it comes from.
function displayableKey(key: string | undefined): string | undefined {
  return key !== undefined && EnvironmentVariableKey.safeParse(key).success ? key : undefined;
}

export const meta = pageMeta(({ params }) => [
  displayableKey(params.keyParam) ?? "Environment variable",
  "Environment variables",
]);

const KeyParamSchema = EnvironmentParamSchema.extend({
  keyParam: z.string(),
});

type MaskedKeyDetail = Omit<EnvironmentVariableKeyDetail, "environments" | "branches"> & {
  environments: Array<{
    environment: EnvironmentVariableKeyDetail["environments"][number]["environment"];
    variable: MaskedEnvironmentVariable | null;
  }>;
  branches: Omit<EnvironmentVariableKeyDetail["branches"], "variables"> & {
    variables: MaskedEnvironmentVariable[];
  };
};

// The panel's data depends on the project, the key and its own search params (the branches
// search and page). A navigation that changes only the list's (its filter, search or page)
// leaves the panel as it is, so don't reload it. Anything after a form submission still
// revalidates.
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (
    (formMethod === undefined || formMethod.toUpperCase() === "GET") &&
    navigationKeepsKeyPanel({ currentUrl, nextUrl, currentParams, nextParams })
  ) {
    return false;
  }

  return defaultShouldRevalidate;
};

export const loader = dashboardLoader(
  {
    params: KeyParamSchema,
    searchParams: z.object({
      [KEY_PANEL_BRANCH_SEARCH_PARAM]: z.string().trim().min(1).optional().catch(undefined),
      [KEY_PANEL_BRANCH_PAGE_PARAM]: z.coerce.number().int().min(1).catch(1),
    }),
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // No hard authorization, as on the list: values in environments the role can't read are
    // masked per-tier below.
  },
  async ({ params, searchParams, user, ability, context }) => {
    const { projectId } = context;
    if (!projectId) {
      throw new Response("Not Found", { status: 404 });
    }

    try {
      const detail = await new EnvironmentVariableKeyPresenter().call({
        userId: user.id,
        projectId,
        key: params.keyParam,
        branchSearch: searchParams[KEY_PANEL_BRANCH_SEARCH_PARAM],
        branchPage: searchParams[KEY_PANEL_BRANCH_PAGE_PARAM],
      });

      // Withhold values (and the "who/when" metadata) for environments the role can't read,
      // exactly as the list does: never serialize them to the client.
      const mask = (variable: EnvironmentVariableWithSetValues): MaskedEnvironmentVariable =>
        ability.can("read", { type: "envvars", envType: variable.environment.type })
          ? variable
          : maskEnvironmentVariable(variable);

      const masked: MaskedKeyDetail = {
        ...detail,
        environments: detail.environments.map((row) => ({
          environment: row.environment,
          variable: row.variable ? mask(row.variable) : null,
        })),
        branches: { ...detail.branches, variables: detail.branches.variables.map(mask) },
      };

      return typedjson(masked);
    } catch (error) {
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

export default function Page() {
  const detail = useTypedLoaderData<MaskedKeyDetail>();
  const outletContext = useOutletContext<EnvironmentVariablesOutletContext>();
  const { revealAll } = outletContext;
  const pageData = useTypedMatchesData<EnvironmentVariablesPageLoaderData>({
    id: environmentVariablesRouteId,
  });
  const writableEnvironmentIds = new Set(pageData?.writableEnvironmentIds ?? []);

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const navigate = useNavigate();

  const searchParams = new URLSearchParams(location.search);
  // Closing keeps the list's view and drops the panel's own params.
  const closePath = `${v3EnvironmentVariablesPath(organization, project, environment)}${listViewSearch(searchParams)}`;
  const keyPath = v3EnvironmentVariableKeyPath(organization, project, environment, detail.key);

  // The create dialog, over the panel. With an environment it starts on this key there; with
  // fillKey it starts on this key and leaves the environments as the list has them.
  // With addOverride it starts on this key in Preview, on its branch picker, with the secret
  // switch on when the Preview base value is secret.
  const newVariablePath = (
    start?:
      | { environmentId: string }
      | { fillKey: true }
      | { addOverride: { previewEnvironmentId: string; isSecret: boolean } }
  ) => {
    const params = new URLSearchParams(keyPanelViewSearch(searchParams));
    if (start && "environmentId" in start) {
      params.set(NEW_VARIABLE_ENVIRONMENT_PARAM, start.environmentId);
    } else if (start && "addOverride" in start) {
      params.set(NEW_VARIABLE_ENVIRONMENT_PARAM, start.addOverride.previewEnvironmentId);
      params.set(NEW_VARIABLE_PICK_BRANCH_PARAM, "1");
      if (start.addOverride.isSecret) {
        params.set(NEW_VARIABLE_SECRET_PARAM, "1");
      }
    } else if (start) {
      params.set(NEW_VARIABLE_FILL_KEY_PARAM, "1");
    }
    return `${keyPath}/new?${params.toString()}`;
  };

  // The environment whose value is being edited in place. One row at a time.
  // Held with its key: this component stays mounted when another key's panel opens, and that
  // panel must not pick up an edit (or its draft) started on this one.
  const [editingValue, setEditingValue] = useState<InlineValueEdit | null>(null);
  const activeEdit = activeInlineValueEdit(editingValue, detail.key, (environmentId) =>
    detail.environments.some((row) => row.environment.id === environmentId && row.variable)
  );
  const settingEnvironmentId = activeEdit?.kind === "set" ? activeEdit.environmentId : null;
  const editingEnvironmentId = activeEdit?.kind === "edit" ? activeEdit.environmentId : null;
  const startEditing = (environmentId: string, kind: InlineValueEdit["kind"]) =>
    setEditingValue({ key: detail.key, environmentId, kind });
  const setEditingEnvironmentId = (environmentId: string) => startEditing(environmentId, "edit");
  const stopEditing = useCallback(() => setEditingValue(null), []);
  const editing = { editingEnvironmentId, setEditingEnvironmentId, stopEditing };
  // A set whose save went through ends here: the reloaded row has its value, and the set
  // editor unmounted before it could report done. Cleared while rendering so a later delete of
  // that value doesn't open the editor again.
  if (editingValue?.key === detail.key && activeEdit === null) {
    setEditingValue(null);
  }

  // The branches an override can be added for: no value of their own, and writable.
  const overridableBranches = detail.unsetBranches.filter((branch) =>
    writableEnvironmentIds.has(branch.id)
  );
  const previewBaseRow = detail.environments.find((row) => row.environment.type === "PREVIEW");

  // The branch search in the Preview branches heading. Open while a search is applied, or once
  // opened on this key (held with its key, like the inline edit).
  const [branchSearchOpenKey, setBranchSearchOpenKey] = useState<string | null>(null);
  const isBranchSearchOpen = branchSearchOpenKey === detail.key || Boolean(detail.branches.search);
  const { del: deleteSearchParams } = useSearchParams();
  const branchSearchButtonRef = useRef<HTMLButtonElement>(null);
  const focusBranchSearchButton = useRef(false);
  const closeBranchSearch = ({ restoreFocus, clearSearch = true }: CloseBranchSearchOptions) => {
    setBranchSearchOpenKey(null);
    focusBranchSearchButton.current = restoreFocus;
    if (clearSearch && detail.branches.search) {
      deleteSearchParams([KEY_PANEL_BRANCH_SEARCH_PARAM, KEY_PANEL_BRANCH_PAGE_PARAM]);
    }
  };
  useEffect(() => {
    if (!isBranchSearchOpen && focusBranchSearchButton.current) {
      focusBranchSearchButton.current = false;
      branchSearchButtonRef.current?.focus();
    }
  });

  // Dialogs opened from the panel close on Esc themselves; the same press mustn't also close
  // the panel. Radix traps focus inside an open dialog, so focus tells us one is open. While a
  // value is edited in place, Esc ends the edit instead.
  useShortcutKeys({
    shortcut: { key: "esc" },
    action: () => {
      if (document.activeElement?.closest("[role='dialog'], [role='alertdialog']")) return;
      if (activeEdit !== null) {
        stopEditing();
        return;
      }
      // An open branch search closes first, as an edit does.
      if (isBranchSearchOpen) {
        closeBranchSearch({ restoreFocus: true });
        return;
      }
      navigate(closePath);
    },
  });

  const displayKey = displayableKey(detail.key);
  const { pagination } = detail.branches;
  const branchPagePath = (page: number) => {
    const params = new URLSearchParams(location.search);
    if (page > 1) {
      params.set(KEY_PANEL_BRANCH_PAGE_PARAM, String(page));
    } else {
      params.delete(KEY_PANEL_BRANCH_PAGE_PARAM);
    }
    return `${location.pathname}?${params.toString()}`;
  };

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
        {displayKey ? (
          <Header2 className="flex min-w-0 font-mono">
            <CopyableText value={displayKey} truncate />
          </Header2>
        ) : (
          <Header2 className="truncate">Environment variable</Header2>
        )}
        <LinkButton
          to={closePath}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc", enabled: false }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
          aria-label="Close"
        />
      </div>

      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {!detail.exists ? (
          <div className="flex flex-col items-start gap-3 px-3 py-4">
            <Paragraph variant="small">
              {displayKey ? (
                <>
                  There's no environment variable named{" "}
                  <span className="font-mono text-text-bright">{displayKey}</span> in this project.
                </>
              ) : (
                "There's no environment variable with that name in this project."
              )}
            </Paragraph>
            <LinkButton
              to={newVariablePath(displayKey ? { fillKey: true } : undefined)}
              variant="secondary/small"
              LeadingIcon={PlusIcon}
            >
              Add new
            </LinkButton>
          </div>
        ) : (
          <>
            <Section title="Environments">
              <Property.Table className="px-3">
                {detail.environments.map(({ environment: rowEnvironment, variable }) => (
                  <Property.Item key={rowEnvironment.id}>
                    <Property.Label className="flex items-center gap-1">
                      <EnvironmentCombo
                        environment={
                          // The Preview environment's own value is the base its branches inherit.
                          rowEnvironment.type === "PREVIEW"
                            ? { type: "PREVIEW", branchName: null }
                            : rowEnvironment
                        }
                        className="text-sm"
                      />
                      {rowEnvironment.type === "PREVIEW" && (
                        <span className="font-normal text-text-dimmed">base</span>
                      )}
                    </Property.Label>
                    <Property.Value>
                      {variable ? (
                        <>
                          <div className="flex min-h-8 items-center gap-2">
                            <PanelValue
                              variable={variable}
                              revealAll={revealAll}
                              editing={editing}
                            />
                          </div>
                          {!variable.permissionDenied && (
                            <EnvironmentVariableUpdated variable={variable} />
                          )}
                        </>
                      ) : settingEnvironmentId === rowEnvironment.id ? (
                        <InlineValueEditor
                          key={`${detail.key}:${rowEnvironment.id}`}
                          target={{
                            kind: "set",
                            key: detail.key,
                            environment: rowEnvironment,
                            actionPath: newVariablePath(),
                          }}
                          onDone={stopEditing}
                        />
                      ) : (
                        <div className="flex min-h-8 items-center justify-between gap-2">
                          <span className="text-xs">Not set</span>
                          {writableEnvironmentIds.has(rowEnvironment.id) && (
                            <Button
                              type="button"
                              variant="tertiary/small"
                              LeadingIcon={PlusIcon}
                              onClick={() => startEditing(rowEnvironment.id, "set")}
                            >
                              Set
                            </Button>
                          )}
                        </div>
                      )}
                    </Property.Value>
                  </Property.Item>
                ))}
              </Property.Table>
            </Section>

            {detail.counts.branches > 0 && (
              <Section
                heading={
                  <BranchesHeading
                    isSearchOpen={isBranchSearchOpen}
                    onOpenSearch={() => setBranchSearchOpenKey(detail.key)}
                    onCloseSearch={closeBranchSearch}
                    searchButtonRef={branchSearchButtonRef}
                    canSearch={detail.counts.branchesSet > 0}
                    accessory={
                      <>
                        <BranchesCountBadge counts={detail.counts} />
                        {overridableBranches.length > 0 && previewBaseRow && (
                          <LinkButton
                            to={newVariablePath({
                              addOverride: {
                                previewEnvironmentId: previewBaseRow.environment.id,
                                isSecret: previewBaseRow.variable?.isSecret === true,
                              },
                            })}
                            variant="tertiary/small"
                            LeadingIcon={PlusIcon}
                          >
                            Add override
                          </LinkButton>
                        )}
                      </>
                    }
                  />
                }
              >
                <Property.Table className="px-3">
                  {detail.branches.variables.map((variable) => (
                    <Property.Item key={variable.environment.id}>
                      <Property.Label className="flex min-w-0 items-center gap-1">
                        <EnvironmentCombo environment={variable.environment} className="text-sm" />
                      </Property.Label>
                      <Property.Value>
                        <div className="flex min-h-8 items-center gap-2">
                          <PanelValue variable={variable} revealAll={revealAll} editing={editing} />
                        </div>
                        {!variable.permissionDenied && (
                          <EnvironmentVariableUpdated variable={variable} />
                        )}
                      </Property.Value>
                    </Property.Item>
                  ))}
                </Property.Table>
                {detail.branches.search && detail.branches.variables.length === 0 && (
                  <Paragraph variant="small" className="px-3 py-2 text-text-dimmed">
                    No branches match
                  </Paragraph>
                )}
                {pagination.totalPages > 1 && (
                  <nav
                    className="flex items-center justify-end gap-1 px-3 pt-2"
                    aria-label="Branches pagination"
                  >
                    <span className="text-xs tabular-nums text-text-dimmed">
                      Page {pagination.currentPage} of {pagination.totalPages}
                    </span>
                    <LinkButton
                      to={branchPagePath(pagination.currentPage - 1)}
                      variant="secondary/small"
                      LeadingIcon={ChevronLeftIcon}
                      disabled={pagination.currentPage === 1}
                      className="px-2"
                      aria-label="Previous branches"
                      replace
                    />
                    <LinkButton
                      to={branchPagePath(pagination.currentPage + 1)}
                      variant="secondary/small"
                      TrailingIcon={ChevronRightIcon}
                      disabled={pagination.currentPage === pagination.totalPages}
                      className="px-2"
                      aria-label="Next branches"
                      replace
                    />
                  </nav>
                )}
              </Section>
            )}
          </>
        )}
      </div>
      {/* The create dialog, when it is opened from the panel. */}
      <Outlet context={outletContext} />
    </div>
  );
}

function Section({
  title,
  accessory,
  heading,
  children,
}: {
  title?: string;
  /** Shown at the right end of the heading's line. */
  accessory?: ReactNode;
  /** The whole heading line, in place of the title and accessory. */
  heading?: ReactNode;
  children: ReactNode;
}) {
  const hasHeading = Boolean(title || heading);
  return (
    <section
      className={cn("border-b border-grid-dimmed pb-3 last:border-b-0", !hasHeading && "pt-3")}
    >
      {heading ? (
        <div className="flex min-h-11 items-center gap-2 px-3 pb-2 pt-3">{heading}</div>
      ) : (
        title && (
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
            <Header3>{title}</Header3>
            {accessory}
          </div>
        )
      )}
      {children}
    </section>
  );
}

type CloseBranchSearchOptions = {
  /** Put focus back on the search button. Not when focus has already gone somewhere else. */
  restoreFocus: boolean;
  /** Remove the search from the URL. Not needed when the input has just done that itself. */
  clearSearch?: boolean;
};

/**
 * The Preview branches heading. At rest: the label, a search button beside it, and the count and
 * Add override at the right. Searching: the label, unchanged, and the standard search input over
 * the rest of the line. The search applies on Enter (`branchSearch` in the URL). Escape, the
 * input's clear button, or leaving the input empty closes it and clears the search.
 */
function BranchesHeading({
  isSearchOpen,
  onOpenSearch,
  onCloseSearch,
  searchButtonRef,
  canSearch,
  accessory,
}: {
  isSearchOpen: boolean;
  onOpenSearch: () => void;
  onCloseSearch: (options: CloseBranchSearchOptions) => void;
  searchButtonRef: RefObject<HTMLButtonElement>;
  /** No search button when no branch has its own value. */
  canSearch: boolean;
  /** The count and Add override, shown while the search is closed. */
  accessory: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.4, 0, 0.2, 1] as const };
  // Focus the input when the user opens the search, not when the page loads with one applied.
  const [openedByUser, setOpenedByUser] = useState(false);
  // The search stays mounted while it animates out: close it once.
  const closing = useRef(false);
  useEffect(() => {
    if (isSearchOpen) closing.current = false;
  }, [isSearchOpen]);
  const close = (options: CloseBranchSearchOptions) => {
    if (closing.current) return;
    closing.current = true;
    setOpenedByUser(false);
    onCloseSearch(options);
  };

  return (
    <>
      {/* The label keeps its place and size whatever is beside it. */}
      <Header3 className="shrink-0 whitespace-nowrap">Preview branches</Header3>
      <div className="relative flex min-w-0 flex-1 items-center">
        <AnimatePresence initial={false} mode="popLayout">
          {isSearchOpen ? (
            <motion.div
              key="search"
              className="min-w-0 flex-1"
              // Grows from the search button's place to the right. The negative insets keep the
              // input's focus ring from being clipped.
              initial={{ clipPath: "inset(-4px 100% -4px -4px)", opacity: 0 }}
              animate={{ clipPath: "inset(-4px -4px -4px -4px)", opacity: 1 }}
              exit={{ clipPath: "inset(-4px 100% -4px -4px)", opacity: 0 }}
              transition={transition}
              // Using the search keeps it open, also one that was applied when the page loaded.
              onFocus={onOpenSearch}
              // Escape closes the search in one press, before the input's own Escape (which
              // clears first) and before the panel's (which closes the panel).
              onKeyDownCapture={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close({ restoreFocus: true });
                }
              }}
              // The input's only button is its clear button, which has just emptied the field
              // and removed the search from the URL.
              onClick={(event) => {
                if (event.target instanceof Element && event.target.closest("button")) {
                  close({ restoreFocus: true, clearSearch: false });
                }
              }}
              // Leaving the input empty closes it. Not when the whole window loses focus.
              onBlur={(event) => {
                if (
                  event.target instanceof HTMLInputElement &&
                  event.target.value === "" &&
                  document.hasFocus()
                ) {
                  close({ restoreFocus: false });
                }
              }}
            >
              <SearchInput
                placeholder="Search branches…"
                paramName={KEY_PANEL_BRANCH_SEARCH_PARAM}
                resetParams={[KEY_PANEL_BRANCH_PAGE_PARAM]}
                autoFocus={openedByUser}
                fullWidth
              />
            </motion.div>
          ) : (
            <motion.div
              key="rest"
              className="flex min-w-0 flex-1 items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
            >
              {canSearch && (
                <Button
                  ref={searchButtonRef}
                  type="button"
                  variant="minimal/small"
                  LeadingIcon={MagnifyingGlassIcon}
                  className="px-1"
                  aria-label="Search branches"
                  tooltip="Search branches"
                  onClick={() => {
                    setOpenedByUser(true);
                    onOpenSearch();
                  }}
                />
              )}
              <div className="ml-auto flex items-center gap-2">{accessory}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

/** How many Preview branches set their own value, out of all of them, as "2 / 40". */
function BranchesCountBadge({ counts }: { counts: EnvironmentVariableKeyCounts }) {
  const others =
    counts.previewBase === "set" ? "The others use the Preview base." : "The others have no value.";
  const description =
    counts.branchesSet === counts.branches
      ? `All ${counts.branches} ${counts.branches === 1 ? "branch sets its" : "branches set their"} own value.`
      : `${counts.branchesSet} of ${counts.branches} ${counts.branches === 1 ? "branch" : "branches"} ${
          counts.branchesSet === 1 ? "sets its" : "set their"
        } own value. ${others}`;
  return (
    <SimpleTooltip
      disableHoverableContent
      buttonClassName="rounded-full focus-custom"
      button={
        <Badge className="tabular-nums">
          <span aria-hidden>
            {counts.branchesSet} / {counts.branches}
          </span>
          <span className="sr-only">{description}</span>
        </Badge>
      }
      content={description}
    />
  );
}

type Editing = {
  editingEnvironmentId: string | null;
  setEditingEnvironmentId: (environmentId: string) => void;
  stopEditing: () => void;
};

/**
 * A set value in the panel: the value as the list shows it with edit and delete, or, while it is
 * being edited, the inline editor. Its parts are siblings, so a branch row's grid lays them out. Focus goes back to the edit button when the edit ends.
 */
function PanelValue({
  variable,
  revealAll,
  editing,
}: {
  variable: MaskedEnvironmentVariable;
  revealAll: boolean;
  editing: Editing;
}) {
  const { counts } = useTypedLoaderData<MaskedKeyDetail>();
  const isEditing = editing.editingEnvironmentId === variable.environment.id;
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !isEditing) {
      editButtonRef.current?.focus();
    }
    wasEditing.current = isEditing;
  }, [isEditing]);

  if (isEditing) {
    return (
      <div className="col-span-2 min-w-0 flex-1">
        <InlineValueEditor
          key={`${variable.key}:${variable.environment.id}`}
          target={{ kind: "edit", variable }}
          onDone={editing.stopEditing}
        />
      </div>
    );
  }

  return (
    <>
      <div className="min-w-0 flex-1">
        <EnvironmentVariableValue variable={variable} revealAll={revealAll} />
      </div>
      {/* As in the table: no edit or delete for a value the role can't read. */}
      <div className={"flex shrink-0 items-center"}>
        {!variable.permissionDenied && (
          <>
            <Button
              ref={editButtonRef}
              type="button"
              variant="small-menu-item"
              LeadingIcon={PencilSquareIcon}
              aria-label="Edit"
              onClick={() => editing.setEditingEnvironmentId(variable.environment.id)}
            />
            <DeleteEnvironmentVariableButton
              variable={variable}
              previewBase={counts.previewBase === "set" ? "set" : "unset"}
            />
          </>
        )}
      </div>
    </>
  );
}

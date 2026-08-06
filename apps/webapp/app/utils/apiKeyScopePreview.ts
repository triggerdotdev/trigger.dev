export type ApiKeyScopePreviewPreset = {
  label: string;
  scopes?: string[];
  usesTaskSelection?: boolean;
};

export type ApiKeyScopePreview = {
  fullAccess: boolean;
  scopes: string[];
};

export function getApiKeyScopePreview({
  preset,
  taskScope,
  selectedTasks,
}: {
  preset?: ApiKeyScopePreviewPreset;
  taskScope?: "all" | "selected";
  selectedTasks: string[];
}): ApiKeyScopePreview {
  const scopes = preset?.scopes;
  if (!scopes) {
    return { fullAccess: false, scopes: [] };
  }

  const fullAccess = scopes.includes("admin");
  const selectedTaskScope =
    preset?.usesTaskSelection && taskScope === "selected" && selectedTasks.length > 0;

  return {
    fullAccess,
    scopes: fullAccess
      ? []
      : scopes.flatMap((scope) => expandTaskScope(scope, selectedTaskScope, selectedTasks)),
  };
}

function expandTaskScope(scope: string, selectedTaskScope: boolean, selectedTasks: string[]): string[] {
  const parts = scope.split(":");
  if (!selectedTaskScope || parts.length !== 2 || parts[1] !== "tasks") {
    return [scope];
  }

  const shown = selectedTasks.slice(0, 3).map((task) => `${scope}:${task}`);
  if (selectedTasks.length > 3) {
    shown.push(`… +${selectedTasks.length - 3} more`);
  }
  return shown;
}

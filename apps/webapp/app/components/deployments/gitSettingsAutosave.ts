export type GitSettingsValues = {
  productionBranch: string;
  stagingBranch: string;
  previewDeploymentsEnabled: boolean;
};

export function gitSettingsKey(values: GitSettingsValues) {
  return JSON.stringify([
    values.productionBranch.trim(),
    values.stagingBranch.trim(),
    values.previewDeploymentsEnabled,
  ]);
}

export type AutosaveState = { pending: boolean; saving: boolean; error?: string };

/** Debounces complete snapshots and admits only one write at a time. */
export function createGitSettingsAutosave({
  initial,
  save,
  changed,
  schedule = (callback) => {
    const timer = setTimeout(callback, 600);
    return () => clearTimeout(timer);
  },
}: {
  initial: GitSettingsValues;
  save: (values: GitSettingsValues) => Promise<void>;
  changed: (state: AutosaveState) => void;
  schedule?: (callback: () => void) => () => void;
}) {
  let latest = initial;
  let savedKey: string | undefined = gitSettingsKey(initial);
  let writing = false;
  let ready = false;
  let disposed = false;
  let cancel: (() => void) | undefined;
  let error: string | undefined;
  const emit = () => {
    if (!disposed)
      changed({ pending: writing || gitSettingsKey(latest) !== savedKey, saving: writing, error });
  };
  async function flush() {
    if (writing || !ready || gitSettingsKey(latest) === savedKey) return;
    ready = false;
    writing = true;
    const snapshot = { ...latest };
    const key = gitSettingsKey(snapshot);
    emit();
    try {
      await save(snapshot);
      savedKey = key;
      error = undefined;
    } catch (cause) {
      // A lost response may follow a successful write. Reverting still needs a save.
      savedKey = undefined;
      error = cause instanceof Error ? cause.message : "Couldn't save GitHub settings. Try again.";
      // Do not loop on errors. A newer edit or explicit retry owns recovery.
      if (gitSettingsKey(latest) === key) ready = false;
    } finally {
      writing = false;
      emit();
      if (ready) void flush();
    }
  }
  function update(values: GitSettingsValues) {
    if (disposed) return;
    latest = { ...values };
    error = undefined;
    ready = false;
    cancel?.();
    emit();
    cancel = schedule(() => {
      ready = true;
      void flush();
    });
  }
  return {
    update,
    retry: () => update(latest),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancel?.();
      // Detach UI notifications, but drain the latest snapshot in order even if
      // navigation happens during the debounce or an earlier request.
      ready = true;
      void flush();
    },
  };
}

/** The existing resource action validates both branch names before acknowledging the write. */
export async function saveGitSettings(url: string, values: GitSettingsValues) {
  const body = new FormData();
  body.set("action", "update-git-settings");
  body.set("productionBranch", values.productionBranch);
  body.set("stagingBranch", values.stagingBranch);
  if (values.previewDeploymentsEnabled) body.set("previewDeploymentsEnabled", "on");
  const response = await fetch(`${url}?autosave=1`, {
    method: "POST",
    body,
    redirect: "error",
    keepalive: true,
  });
  const result: unknown = await response.json();
  if (
    !response.ok ||
    !result ||
    typeof result !== "object" ||
    !("ok" in result) ||
    result.ok !== true
  ) {
    const error =
      result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error
        : "Couldn't save GitHub settings. Try again.";
    throw new Error(error);
  }
}

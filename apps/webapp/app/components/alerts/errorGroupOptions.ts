export type ErrorGroupOption = {
  fingerprint: string;
  taskIdentifier: string;
  label: string;
};

const MAX_LABEL = 80;

export function toErrorGroupOptions(
  groups: { fingerprint: string; taskIdentifier: string; errorType: string; errorMessage: string }[]
): ErrorGroupOption[] {
  return groups.map((group) => {
    const label = `${group.taskIdentifier} · ${group.errorType}: ${group.errorMessage}`
      .replace(/\s+/g, " ")
      .trim();
    return {
      fingerprint: group.fingerprint,
      taskIdentifier: group.taskIdentifier,
      label: label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label,
    };
  });
}

export type ResolveErrorGroup = (id: string) => Promise<ErrorGroupOption | undefined>;

/** Looks up one error group by `error_…` id or fingerprint through the error-groups route. */
export function errorGroupResolver(groupsUrl: string): ResolveErrorGroup {
  return async (id) => {
    try {
      const res = await fetch(`${groupsUrl}?id=${encodeURIComponent(id.trim())}`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { groups?: ErrorGroupOption[] };
      return data.groups?.[0];
    } catch {
      return undefined;
    }
  };
}

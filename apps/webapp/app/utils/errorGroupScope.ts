export type ErrorGroupScope = {
  type: "errorGroup";
  taskIdentifier: string;
  fingerprint: string;
};

const SEPARATOR = "#";

export function encodeErrorGroupScope(scope: {
  taskIdentifier: string;
  fingerprint: string;
}): string {
  return `${scope.taskIdentifier}${SEPARATOR}${scope.fingerprint}`;
}

export function parseErrorGroupScope(value: string | undefined): ErrorGroupScope | undefined {
  if (!value) return undefined;
  const at = value.lastIndexOf(SEPARATOR);
  if (at <= 0 || at === value.length - 1) return undefined;
  return {
    type: "errorGroup",
    taskIdentifier: value.slice(0, at),
    fingerprint: value.slice(at + 1),
  };
}

/** `error_<fingerprint>` or a bare fingerprint to the fingerprint. */
export function errorFingerprint(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("error_") ? trimmed.slice("error_".length) || undefined : trimmed;
}

export function errorGroupLabel(value: string | undefined): string {
  const scope = parseErrorGroupScope(value);
  return scope ? `${scope.taskIdentifier} · ${scope.fingerprint.slice(0, 8)}` : (value ?? "");
}

import {
  buildJwtAbility,
  buildScopeMatcher,
  type ApiKeyScopeUseEvent,
  type RbacAbility,
  type RbacResource,
} from "@trigger.dev/plugins";

export type ApiKeyScopeRecorder = (event: ApiKeyScopeUseEvent) => void;

type ApiKeyScopeUseTarget = Omit<ApiKeyScopeUseEvent, "used">;

export function recordingApiKeyAbility(
  scopes: string[],
  target: ApiKeyScopeUseTarget,
  record: ApiKeyScopeRecorder
): RbacAbility {
  const ability = buildJwtAbility(scopes);
  const matchScope = buildScopeMatcher(scopes);
  const sent = new Set<string>();
  const used = new Set<string>();
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;
    if (used.size === 0) return;
    const event: ApiKeyScopeUseEvent = { ...target, used: [...used] };
    used.clear();
    try {
      record(event);
    } catch {}
  };

  return {
    can(action: string, resource: RbacResource | RbacResource[]): boolean {
      if (!ability.can(action, resource)) return false;
      const scope = matchScope(action, resource);
      if (scope !== undefined && !sent.has(scope)) {
        sent.add(scope);
        used.add(scope);
        if (!flushScheduled) {
          flushScheduled = true;
          setImmediate(flush);
        }
      }
      return true;
    },
    canSuper: () => ability.canSuper(),
  };
}

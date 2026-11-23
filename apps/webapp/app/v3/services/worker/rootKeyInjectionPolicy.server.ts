export function rootKeyInjectionDisabled(environment: {
  rootKeyInjectionDisabledAt: Date | null;
  parentEnvironment?: { rootKeyInjectionDisabledAt: Date | null } | null;
}) {
  return (environment.parentEnvironment ?? environment).rootKeyInjectionDisabledAt !== null;
}

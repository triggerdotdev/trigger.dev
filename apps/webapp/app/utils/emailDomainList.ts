/**
 * Whether an email's domain is in an operator-supplied list of domains
 * (BLOCKED_EMAIL_DOMAINS). The list is comma or whitespace separated, and an
 * entry matches its own domain and every subdomain of it, case-insensitively.
 *
 * Dependency-free so it can be tested directly; callers pass the list from `env`.
 */
export function emailDomainIsListed(domainList: string, email: string): boolean {
  const domain = normalizeDomain(email.slice(email.lastIndexOf("@") + 1));
  if (!domain) {
    return false;
  }

  return parseDomainList(domainList).some(
    (entry) => domain === entry || domain.endsWith(`.${entry}`)
  );
}

function parseDomainList(domainList: string): string[] {
  return domainList
    .split(/[\s,]+/)
    .map((entry) => normalizeDomain(entry.replace(/^[@.]+/, "")))
    .filter((entry) => entry.length > 0);
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "");
}

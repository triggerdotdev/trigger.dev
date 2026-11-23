const GIT_TRANSPORTS = new Set(["ssh:", "git+ssh:", "git:"]);

/**
 * A git remote as the https URL of its repository page, without credentials or a trailing
 * `.git`. Accepts http(s), ssh (`git@host:owner/repo.git`, `ssh://git@host/owner/repo`) and
 * `git://` remotes; returns null for anything else.
 */
export function gitRemoteToHttpsUrl(remoteUrl: string): string | null {
  const remote = remoteUrl.trim();

  // scp-style ssh remotes aren't URLs: git@github.com:owner/repo.git
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(remote);

  let url: URL;
  try {
    url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    if (GIT_TRANSPORTS.has(url.protocol)) {
      url = new URL(`https://${url.hostname}${url.pathname}`);
    }
  } catch {
    return null;
  }

  if (!isHttpProtocol(url.protocol)) return null;

  url.username = "";
  url.password = "";
  url.protocol = "https:";

  return url.toString().replace(/\.git$/, "");
}

/** True for an absolute http or https URL. */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return isHttpProtocol(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isHttpProtocol(protocol: string) {
  return protocol === "https:" || protocol === "http:";
}

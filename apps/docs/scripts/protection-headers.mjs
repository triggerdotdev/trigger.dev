// Headers that let a check through a deployment's Vercel Authentication. Callers send them only to
// the deployment under check, never to another host.
// - DOCS_TRUSTED_OIDC=1, in a GitHub Actions job with `id-token: write`: the job's own GitHub OIDC
//   token, which the project's Trusted Sources rule for this repository accepts. No stored secret.
// - Otherwise the project's Protection Bypass for Automation secret, if VERCEL_AUTOMATION_BYPASS_SECRET is set.
let oidc; // the pending or current token request, shared by concurrent callers

export async function protectionHeaders(env = process.env) {
  if (env.DOCS_TRUSTED_OIDC === "1") {
    const current = oidc;
    let token = current && (await current.catch(() => null));
    // Refetched a minute before it expires, so a long check never sends an expired token; only
    // the first caller to notice starts the request.
    if (!token || token.exp - Date.now() / 1000 < 60) {
      if (oidc === current) oidc = githubOidcToken(env);
      token = await oidc;
    }
    return { "x-vercel-trusted-oidc-idp-token": token.token };
  }
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return bypass ? { "x-vercel-protection-bypass": bypass } : {};
}

async function githubOidcToken(env) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const auth = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !auth)
    throw new Error("DOCS_TRUSTED_OIDC=1 needs a GitHub Actions job with `id-token: write`");
  // No audience parameter: GitHub's default, https://github.com/<owner>, is the audience Vercel's
  // GitHub Actions rule expects.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth}` } });
  if (!res.ok) throw new Error(`GitHub OIDC token request: HTTP ${res.status}`);
  const { value } = await res.json();
  const { exp } = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
  return { token: value, exp };
}

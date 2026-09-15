export type AuthUser = {
  userId: string;
  // Present only when the session was established via SSO. Carries the
  // minimum the periodic re-validation hook needs to ask the IdP whether
  // the session is still valid. Signed into the session cookie, so it's
  // tamper-proof. Absent ⇒ non-SSO session ⇒ never revalidated.
  sso?: {
    idpOrgId: string;
    connectionId: string;
  };
};

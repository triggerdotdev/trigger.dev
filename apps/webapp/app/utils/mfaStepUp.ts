export const MFA_STEP_UP_ACTIONS = [
  "environmentVariables",
  "accessTokens",
  "organizationSecurity",
] as const;
export type MfaStepUpAction = (typeof MFA_STEP_UP_ACTIONS)[number];

export const MFA_STEP_UP_WINDOW_MINUTES = [5, 15, 30, 60] as const;

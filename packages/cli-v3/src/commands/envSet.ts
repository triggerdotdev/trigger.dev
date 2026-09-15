/** Build the import-env-vars body. Omit `isSecret` unless `--secret` so an existing secret is not demoted. */
export function buildEnvSetImportBody(name: string, value: string, secret: boolean) {
  return {
    variables: { [name]: value },
    override: true as const,
    ...(secret ? { isSecret: true as const } : {}),
  };
}

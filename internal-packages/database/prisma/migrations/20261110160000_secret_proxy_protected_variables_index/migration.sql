CREATE INDEX CONCURRENTLY IF NOT EXISTS "EnvironmentVariableValue_proxyOnly_environmentId_idx" ON "EnvironmentVariableValue" ("environmentId") WHERE "isProxyOnly" = true;

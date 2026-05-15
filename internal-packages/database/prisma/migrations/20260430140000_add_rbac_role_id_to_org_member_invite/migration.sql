-- TRI-8892: optional RBAC role assignment carried on the invite. When
-- set, the accept-invite flow calls the loaded RBAC plugin's
-- setUserRole(rbacRoleId) after the OrgMember insert; otherwise the
-- runtime fallback derives the role from the legacy `role` column.
ALTER TABLE "OrgMemberInvite" ADD COLUMN IF NOT EXISTS "rbacRoleId" TEXT;

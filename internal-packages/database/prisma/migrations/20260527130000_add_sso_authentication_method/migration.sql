-- Idempotent enum addition.
ALTER TYPE "AuthenticationMethod" ADD VALUE IF NOT EXISTS 'SSO';

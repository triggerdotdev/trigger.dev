---
area: webapp
type: breaking
---

Query dashboard APIs reject run tokens and public access tokens without user delegation. Existing API key access, including restricted keys with the required query scopes, is unchanged. MCP dashboard access remains supported through delegated tokens for current organization members.

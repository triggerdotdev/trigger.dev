---
area: webapp
type: feature
---

Add input streams with API routes for sending data to running tasks, SSE reading, and waitpoint creation. Includes Redis cache for fast `.send()` to `.wait()` bridging, dashboard span support for input stream operations, and s2-lite support with configurable S2 endpoint, access token skipping, and S2-Basin headers for self-hosted deployments. Adds s2-lite to Docker Compose for local development.

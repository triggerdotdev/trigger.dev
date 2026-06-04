---
area: webapp
type: fix
---

Validate packet-relative storage paths before building object-store keys or presigned URLs. Rejects:

- an empty path
- absolute paths (leading `/`)
- backslashes (`\`)
- empty path segments (e.g. `foo//bar`, leading or trailing `/`)
- `.` path segments (e.g. `.`, `foo/./bar`)
- `..` path segments (path traversal, e.g. `../file`, `foo/../bar`)
- percent-encoded `.` / `..` segments (e.g. `%2e%2e`, `%2E%2E`, `%2e.`)

After segment checks, paths are normalized with the same URL pathname resolution used by `Aws4FetchClient`, and the full object-store key must remain under `packets/{projectRef}/{envSlug}/` after that normalization.

Applied in `uploadPacketToObjectStore`, `downloadPacketFromObjectStore`, and `generatePresignedRequest`. `Aws4FetchClient` uses shared `normalizeObjectStoreLogicalKeyPathname` for presign/PUT/GET URLs.

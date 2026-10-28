---
area: webapp
type: feature
---

Expand short-lived run-token support to task APIs, with permission checks for packets, metadata, streams and waits. Run tokens last one hour independently of root-key rotation and cannot be individually revoked. They can mint public access tokens for up to 30 days; those tokens may outlive the run token that minted them.

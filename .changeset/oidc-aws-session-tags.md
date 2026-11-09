---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Add opt-in AWS session tags with `awsCredentialProvider({ sessionTags: true })` for task-level IAM restrictions and attribute-based permissions. Tags come from the verified run identity. Update the role trust policy to allow `sts:TagSession` before enabling them; existing integrations remain untagged.

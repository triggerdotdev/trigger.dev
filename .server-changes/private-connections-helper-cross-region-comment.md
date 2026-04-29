---
area: webapp
type: improvement
---

Clarify the cross-region intent in the Terraform and AI-prompt helpers on the Add Private Connection page. Both already default `supported_regions` to `["us-east-1", "eu-central-1"]`; added an inline comment / parenthetical so the user understands why both regions are listed (Trigger.dev runs in both, so the service must be consumable from either).

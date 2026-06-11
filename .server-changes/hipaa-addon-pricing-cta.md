---
area: webapp
type: feature
---

Add a HIPAA BAA add-on row to the Hobby, Pro, and Enterprise tiers on the in-app pricing/plan-selection cards. Each row opens the existing Feedback dialog pre-filled with a new `hipaa` feedback type. Restructure `feedbackTypes` to match the marketing contact form (label / labelTypeId / threadTitle), so every supported inquiry type tags its Plain thread with the same label ID used by the marketing form and uses a consistent "Contact form: …" thread title. Also reformat the included-compute line on each tier ("$X / month free credits" / "$X / month credits included") and move it from the `TierLimit` block into a `FeatureItem` with a `DefinitionTip`, matching the marketing pricing page.

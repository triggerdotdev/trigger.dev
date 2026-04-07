---
"@trigger.dev/core": patch
"@trigger.dev/database": patch
---

Support for org-scoped ClickHouse

Implements OrganizationDataStore system allowing organizations to have data stored in specific separate ClickHouse instances. Adds factory-based client resolution, registry system for organization data store configurations, caching by organization and type, and admin UI routes for dynamic configuration.

---
area: webapp
type: improvement
---

Database queries that filter on a list of values now reuse cached query plans more consistently, instead of forcing the database to re-plan whenever the list length changes.

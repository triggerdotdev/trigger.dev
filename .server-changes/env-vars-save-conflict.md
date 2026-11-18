---
area: webapp
type: fix
---

Saving an environment variable that someone else deletes at the same moment now shows a clear message asking you to try again instead of a database error, and the API answers with a 409. Deleting a value can no longer remove a value that was being added to the same variable at that moment.

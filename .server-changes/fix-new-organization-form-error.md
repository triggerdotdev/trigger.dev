---
area: webapp
type: fix
---

When creating an organization failed, the form quietly cleared the name you typed and showed nothing, so it was easy to submit again and end up with a duplicate. The name is now kept and an error message explains what happened.

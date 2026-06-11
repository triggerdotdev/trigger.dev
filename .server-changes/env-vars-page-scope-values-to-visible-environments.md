---
area: webapp
type: fix
---

Speed up the environment variables page for projects with many archived preview branches. The page now only loads variable values for the environments it displays instead of every value ever created, including those left behind by archived branches.

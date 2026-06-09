---
area: webapp
type: fix
---

Fix an off-by-one in `ClickHouseRunsRepository.listRunIds` backward pagination.
When paging backward with more rows before the page (`hasMore`), the displayed
page was sliced as `rows.slice(1, size + 1)`, which dropped the row closest to
the cursor and kept the extra "has-more" sentinel — returning a page that
straddled two logical pages (one row from the correct previous page plus one
from the page before it). The result set is always the first `page.size` rows
(the sentinel is the trailing element in both directions), so the slice is now
`rows.slice(0, size)` for forward and backward alike. Forward pagination and the
cursor values were already correct and are unchanged.

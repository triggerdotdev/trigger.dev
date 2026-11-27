---
name: docs-dashboard-figures
description: Use when a docs page needs a picture of the Trigger.dev dashboard. Covers drawing a dashboard figure (a dashboard screen built in code from the webapp's own classes and tokens, shown with `<DashboardFigure>` in the docs site at apps/docs), replacing a dashboard screenshot in docs/ with one, adding a figure a page is missing, and refreshing a figure that `check:figures` reports as stale.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Dashboard figures

A dashboard figure is a dashboard screen drawn as a React component, using the webapp's own class strings and design tokens. It is used in place of a screenshot. Compared with a screenshot, a figure:

- follows the reader's light or dark theme
- scales to the column without blurring
- can ring a control with a numbered badge (`highlight`)
- shows a signed-in reader's own project name
- reaches agents as text: the `.md` routes, `llms-full.txt`, MCP and Ask AI get `[Dashboard: <description>]` instead of a picture
- is stamped with the webapp files it copies, so `check:figures` warns when the dashboard changes under it

The bar is **faithful**: someone who knows the dashboard should not be able to tell the figure from a screenshot at the same size. Don't idealize the screen or simplify it.

## Figure or screenshot

Draw a figure for anything the webapp renders: pages, dialogs, side panels, tables, menus, empty states.

Keep an image (or use something else) for:

- other products' UI: GitHub, Vercel, Slack, Supabase, a browser's own chrome
- terminal output: use a code block
- diagrams and architecture pictures
- animated flows (gif or video)
- a screen whose value is a large amount of real data, such as a 40-span trace or a busy chart. Draw only the part the text discusses, or keep the image and say why in your report.

## Files

All paths are under `apps/docs/` unless they start with `.claude/`.

| File | What it is |
| --- | --- |
| `lib/dashboard-figures.ts` | The registry: each figure's description, canvas size, marks and webapp sources. No React (the markdown routes and scripts import it). |
| `components/dashboard-figures/<name>.tsx` | One component per figure. |
| `components/dashboard-figures/index.ts` | Maps each registry name to its component. |
| `components/dashboard-figures/chrome.tsx` | Shared parts: `AppFrame`, `SideMenu`, `PageHeader` (with `crumbs`), `Button`, `RowMenuItem`, `ShortcutKey`, `EnvCombo`, `envs`, `SectionHeader`, `Pagination`, `secondarySmall`, and the table parts (`tableHeader`, `tableRow`, `th`, `td`, `Cell`). |
| `components/dashboard-figures/detail-parts.tsx` | Detail-page parts: `Tab`, `Group`, `Property`, `Copyable`, `ResizableHandle`. |
| `components/dashboard-figures/form-parts.tsx` | Dialogs and form controls: `DialogFrame`, `DialogClose`, `FormButtons`, `Select`, `Switch`, `Input`, `SmallInput`, `Segment`, `CheckboxBox`, and the test page parts: `UnderlineTab`, `Option`, `Editor`. |
| `components/dashboard-figures/chart-parts.tsx` | Charts: `Chart`, `Legend`, `legendHeight`, `compact`, the `Series` type. |
| `components/dashboard-figures/icons.tsx` | The dashboard's icons as inline SVG. |
| `components/dashboard-figures/reader-text.tsx` | `<ReaderText>`: the signed-in reader's project or org name, else the example name. |
| `components/dashboard-figure.tsx` | The `<DashboardFigure>` tag: scaling, `role="img"` with the description, marks. |
| `app/dashboard-figures.css` | The token layer: the webapp's token names and values, dark and light, scoped to `.dash-figure`. |
| `lib/dashboard-figures.stamps.json` | Generated stamps (blob ids of each figure's sources). Never edit by hand. |
| `scripts/check-figures.mjs` | `pnpm --filter docs-site check:figures`: tag check and staleness report; `--stamp` writes stamps. |
| `.claude/skills/docs-dashboard-figures/capture.js` | Turns a rendered dashboard element into figure JSX (see "Capture the markup"). |

## The tag

```mdx
<DashboardFigure name="environment-variables" highlight="nav:1, add-new:2" caption="Optional caption." />
```

- `name` (required): a registry name.
- `highlight` (optional): a comma list of `mark` or `mark:label`. A label is at most 12 characters of letters, digits, spaces, dots and hyphens; it becomes the badge text. A mark the figure doesn't declare fails the build and `check:figures`.
- `caption` (optional): shown under the figure and after the description in the `.md`.
- Always self-closing, string attributes only: the markdown routes and the check find tags with a regex. No import is needed (it is registered in `components/mdx.tsx`).
- Inside a `<Step>`, indent the tag like the step's text.
- Badge numbers must match the text. If the text says "click **Add new** (2)", the tag says `add-new:2`. Ring only what the text points at. A tag with no `highlight` is fine.

### Highlight rule

Every highlight looks the same, on every figure, in both themes: a 3px indigo-500 ring drawn 3px outside the element, and a badge in indigo-500 with white bold text (about 4.8:1 contrast). The offset leaves a strip of the page between the ring and the element, so a ring around a purple primary button (Add new, Run test) still reads as a separate mark. The look lives in two places only: `--color-figure-mark` and `--color-figure-mark-ink` in `app/dashboard-figures.css`, and the outline rule in `components/dashboard-figure.tsx`. Never restyle a mark inside a figure, and never draw your own ring, arrow or number into a figure: the old screenshots' green arrows and numbers become `highlight` items.

## Replace a screenshot

1. **Read the page.** Note what the text tells the reader to look at or do: that decides the crop and the marks. Open the old image (`docs/images/...`) to see what it showed and what the text expects. Check which other pages use the same image (`grep -rn "<image file>" docs/`): one figure can replace it on all of them.
2. **Find the screen in the webapp.** Routes are files and folders under `apps/webapp/app/routes/`. Environment-scoped pages are `_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.<page>/route.tsx` (`.apikeys`, `.environment-variables`, `.runs._index`, `.test.tasks.$taskParam`). A dialog is usually a child route (`.environment-variables.new`). Shared primitives are in `app/components/primitives/` (Buttons, Table, Dialog, Input, Select, Switch, Badge, PageHeader); the side menu is in `app/components/navigation/`. Read the route to learn what renders for your data: which columns, which buttons, which empty state. Search the route name in the registry: an existing figure may already cover the screen, and a new `highlight` is cheaper than a near-duplicate.
3. **Get the markup**, from the live dashboard (preferred) or from source (see "Capture the markup").
4. **Write `components/dashboard-figures/<name>.tsx`** following "Writing the component".
5. **Register it**: add the entry to `lib/dashboard-figures.ts` (see "The registry entry") and the component to `components/dashboard-figures/index.ts`. Name the figure after the screen (`api-keys`, `environment-variables-new`, `runs-list`), not after the page that uses it.
6. **Swap the tag in** where the image was. Delete the `<img>`/`![]()`/`<Frame>` wrapper around it. Keep the image file itself: other pages or old links may use it, and image cleanup is a separate pass. Reread the sentence before and after: if it says "in the screenshot below", fix the wording; if it describes the screen differently from the dashboard today, draw the dashboard as it is, fix the sentence, and say so in your report.
7. **Compare with the dashboard** in dark, light and at phone width (see "Check it against the dashboard"). Fix until you can't tell them apart.
8. **Stamp it**: `pnpm --filter docs-site check:figures --stamp <name>`. Commit the stamps file with the figure.
9. **Run the checks** (in `apps/docs`): `node scripts/check-figures.mjs` (0 tag errors, your figure not listed), `pnpm exec vitest run lib/dashboard-figures.test.ts`, `pnpm exec tsc --noEmit`, and format the files you touched with `pnpm exec oxfmt <files>` from the repo root.

## Add a missing figure

Some pages describe a dashboard screen with no picture ("open the Queues page and ..."). Same steps as above, with these differences:

- Add a figure only where the reader has to find something on the screen: a button, a field, a column, a menu item. Don't add one for a passing mention of a page.
- Put the tag right after the sentence that sends the reader to the screen.
- One figure per screen per page. If an existing figure shows the screen, reuse it with a different `highlight`.

## Capture the markup

### From the live dashboard

Run the webapp locally (see `CONTRIBUTING.md`), or use a dashboard you were pointed at. Treat it as read-only: view pages, don't create, edit or delete anything to get a nicer picture. Open the page at a desktop width (1440x900), then load the helper and capture an element:

```js
// Chrome DevTools MCP: evaluate_script with sourcePath = .claude/skills/docs-dashboard-figures/capture.js
// (Playwright: page.addScriptTag({ path })). Then:
() => window.__figureCapture("<css selector>")             // JSX, svgs inlined
() => window.__figureCapture("<css selector>", { icons: "name" }) // svgs as <Icon name="TODO" /> placeholders
```

It returns JSX with the element's classes as rendered: tags become `div`/`span`, tables become `table`/`table-row`/`table-cell` divs, inputs become a div with their value, SVGs are inlined, and hover, focus, transition and cursor classes are dropped. The first line is the element's rendered size: use it for the canvas size. Narrow the selector to the region you need (`[role=dialog]`, a table, the page body).

The capture is a starting point, not the figure. Afterwards:

- Replace repeated parts with the shared ones from `chrome.tsx` (`AppFrame` and `SideMenu`, `PageHeader`, `Button`, the table parts), `form-parts.tsx` (dialogs and form controls), `detail-parts.tsx` (the property rail), `chart-parts.tsx` (charts) and icons from `icons.tsx`.
- Turn the data into a small array you map over, and replace the live data with example data.
- Delete whatever only exists at runtime: tooltips' hidden content, portals, `sr-only` text, `data-*` attributes.

### From source

When the live dashboard can't show the screen (no tasks, no runs, a plan-gated page), build the markup by reading the components. For each component, take the class strings for the variant and size the route passes (for `Button`, read `Buttons.tsx`'s `variant` and `size` tables) and write the resolved strings. Say in the figure's header comment that it is drawn from source, so the next person compares it with care.

To check a figure drawn from source against the real CSS, open the closest screen the dashboard can show (the empty Runs page for the runs table), convert the figure's markup to real tags, and insert it into that page's DOM next to the real component with `evaluate_script`. It renders with the webapp's own stylesheet, so a wrong class shows up as a size or spacing difference. This changes only the page in your browser; reload to undo.

## Writing the component

Start from a pilot figure that is close to yours:

| Figure | Shows how to draw |
| --- | --- |
| `environment-variables.tsx` | A full page with the side menu, a toolbar and a table. |
| `api-keys.tsx` | A wide table with badges, monospace secrets, status cells and a row menu. |
| `environment-variables-new.tsx` | A dialog: checkboxes, switches, inputs, a footer. |
| `test-task.tsx` | A page without the side menu, tabs, selects, a code editor, drawn from source. |
| `runs-list.tsx` | A table wider than the canvas, cut off under a sticky row menu, with a colspan header and checkboxes, drawn from source. |

Rules:

- **Copy class strings verbatim** from the capture or the source. Don't restyle, don't round sizes, don't use the docs' own classes (`fd-*`, `prose`). The token layer makes the webapp's names work, so `bg-background-bright text-text-dimmed border-grid-bright` means what it means in the dashboard.
- **Resolve tailwind-merge conflicts.** The webapp joins classes with `cn()`, which drops the earlier of two conflicting classes (`-mx-1` vs `-mx-2`, `gap-1.5` vs `gap-0.5`, `px-2` vs `px-3`). A plain string keeps both, and the stylesheet order picks one, often the wrong one. Where the webapp passes an override, replace the base class instead of appending: see `Button`'s `iconClassName` and `EnvCombo`'s `gap` in `chrome.tsx`. Some pairs are not conflicts to `cn()` and both survive: `px-3` with a later `pl-4` or `pr-0`, `size-3.5` with `min-w-4.5`. The stylesheet then decides (the single-side class beats the axis class), so write what wins (`pl-4 pr-3`) rather than both.
- **No semantic tags.** Only `div`, `span` and `svg` (and `path` and friends inside it). No `table`, `button`, `input`, `a`, `hr`, `h1`, `ul` or `label`. The figure is a single `role="img"`; real controls would be focusable and read out on their own. Draw a table with `table`, `table-header-group`, `table-row-group`, `table-row` and `table-cell` classes, a link as a `span` with `text-text-link`, and a divider as a `div` with `h-px`.
- **Add `align-middle` to every `table-cell` div.** A real `<td>` is vertically centered by default; a `display: table-cell` div sits on the baseline, so two-line rows look broken.
- **Tables a div can't express.** A div table has no `colSpan`: put the header label in a `w-0` box inside the first cell so it overflows into the next ones, and add an empty header cell for each spanned column (`Duration` in `runs-list.tsx`). A table wider than the canvas scrolls in the dashboard (`overflow-x-auto`): write `overflow-hidden` instead, keep the columns that run past the edge, and keep `sticky right-0` on the row menu cells so they stay at the right edge as they do on screen.
- **Native form controls** are styled by `@tailwindcss/forms`, which the docs don't load. Draw a checkbox as a `span` with `inline-block size-4 align-middle` plus the webapp's border and background classes.
- **Tokens, not raw colors.** Use the semantic token the webapp uses (`bg-background-dimmed`, `text-success`, `text-dev`). Write a palette class (`bg-indigo-500`, `dark:bg-charcoal-200`) only where the webapp writes that exact class. Never write a hex color or a `charcoal-*` class to imitate the dark theme: it will be wrong in light. If the dashboard uses a token that `app/dashboard-figures.css` doesn't define, add it from `apps/webapp/app/tailwind.css`: the dark value in the `@theme` block and the light value in the light block (see the `--color-editor-*` tokens for an example). Icons with their own fills (`AISparkleIcon`) keep them.
- **Example data is plausible and neutral.** Project `hello-world`, org `Acme`, task `hello-world`, people like `Sam Lee`, `example.com` URLs, `203.0.113.0/24` IPs (a documentation range), dates in the last few weeks, values like `sk_test_example`. Mask secrets the way the dashboard does (`tr_dev_sk_••••••••YBm2`). No real customer, company or person names, nothing that looks like a live key, no jokes and no marketing copy.
- **Wrap the project and org names in `<ReaderText field="project">hello-world</ReaderText>`** (or `field="org"`) wherever the dashboard shows them. `SideMenu` does this already. Signed-in readers then see their own names.
- **Draw the dashboard as it is for that data**, including the plain parts: disabled buttons, empty columns, the `Legacy` badge. Don't add what the dashboard lacks, and don't hide what it has because it seems off-topic. Leave out transient things the text isn't about: toasts, spinners, hover and focus states, tooltips, "connected" pulses, unread dots, live counters. Draw the cloud dashboard (cloud-only parts such as the Compute column included) in the Development environment, unless the text is about another environment or self-hosting.
- **Crop to the region the text talks about, at the dashboard's real pixel size.** Draw the full page with the side menu when the text uses the menu ("select **API keys** in the side menu"). Draw a dialog or panel alone when the text is about it. The canvas scales down to the column (about 700px wide), so a 1440px canvas shows text at half size: keep the width as small as the content allows (1000 to 1200 for a page is typical) and let the page's own content set the height.
- **Marks**: put `data-mark="<mark>"` on each element a page might ring, and list them in the registry's `marks`. Name marks after the control (`nav`, `add-new`, `save`, `run-test`), never after a position or number. `nav` is the side menu item. `Button` takes `mark` and `markBadge`; on other elements write `data-mark` and `data-mark-badge` yourself. The badge sits to the right of the element; `data-mark-badge="below"` or `"left"` moves it where there's room (`"left"` at the canvas's right edge). When a control repeats on every row, mark it on one row only, the one the text is about (the Failed run, for a page about replaying).
- **Nothing may clip a mark.** The ring reaches 6px outside the element and the badge sits 12px out, so an ancestor with `overflow-hidden` (or a `truncate`), or the canvas edge, cuts them off. Check every mark with `highlight` on; move the mark to an element whose ancestors don't clip, move the badge (`data-mark-badge`), or give the canvas a few more pixels.
- **Shared parts first.** Use `AppFrame` + `SideMenu active="<item>" open={["<section>"]}` for full pages, `PageHeader`, `Button` (`variant`, `size`, `icon`, `trailingIcon`, `iconClassName`, `shortcut`, `disabled`, `mark`, `markBadge`), `EnvCombo` and `envs`. If you need a variant they don't have yet, add it there, copied from the webapp primitive, so the next figure gets it too.
- **Icons**: reuse `icons.tsx`. Stock heroicons come from `@heroicons/react` (pinned to the webapp's version): import them from `@heroicons/react/20/solid` or `/24/outline` as the webapp file does, or re-export one from `icons.tsx` when several figures use it. Never copy a heroicon's SVG. To add any other icon, copy its SVG into `icons.tsx` once from the import the webapp uses (`app/assets/icons/*.tsx`), or use `lucide-react`, which the docs already depend on. Don't add other dependencies.
- **Header comment**: one or two lines saying what the figure shows and whether it was copied from the rendered dashboard or drawn from source, ending "the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts".

## The registry entry

```ts
"api-keys": {
  description: "The API keys page in the dashboard, with API keys selected in the side menu under Security and the Create API key button at the top right. A table lists ...",
  width: 1440,
  height: 640,
  marks: ["nav", "create"],
  sources: [...APP_FRAME, `${ROUTES}.apikeys/route.tsx`, `${P}/Table.tsx`, `${P}/Badge.tsx`],
},
```

- **`description`** is the alt text and what agents read instead of the picture, so a reader who can't see the figure must still be able to follow the page. Start with what screen it is ("The API keys page in the dashboard", "The New environment variables dialog"). Then say where the controls the docs mention are, with their exact labels ("the Create API key button at the top right"), then summarize what the example data shows. Two to five plain sentences. Don't describe colors or styling unless the text relies on them.
- **`width` and `height`**: the canvas in CSS pixels, at the dashboard's real size for the crop.
- **`marks`**: every `data-mark` in the component.
- **`sources`**: every webapp file whose markup, classes or text the figure copies, from the repo root, using the `W`, `ROUTES` and `P` constants. Full pages with the side menu start with `...APP_FRAME`. List the route, the route's own components, and each primitive drawn (Buttons, Table, Dialog, Select ...). Add a utility or helper only if it decides visible text or which columns show (`utils/versionLabel.ts`, `runColumns.ts`). Don't list icon files: icons are copied into `icons.tsx` once, and an icon redraw rarely changes what the text points at. The test: if a change to the file could change a pixel of the figure, list it. Too few sources means a stale figure goes unnoticed; too many means noise.

## Check it against the dashboard

Run the docs site (`pnpm --filter docs-site dev`, port 43000; or `pnpm exec next dev --port <port>` in `apps/docs`) and open the page at `/docs/<slug>`; below, `<docs>` is that server's origin. Open the same screen in the dashboard, in the same browser at the same viewport (1440x900).

A figure inside a `<Tab>` isn't rendered until its tab is selected, not even in the page's HTML: select the tab first (the MCP `click` tool, or dispatch a `mousedown` on its `[role=tab]`).

To compare at real size, pin the figure's viewport so it renders at scale 1. On the docs page:

```js
const v = document.querySelector('.dash-figure[data-figure="<name>"] .dash-figure-viewport');
Object.assign(v.style, { position: "fixed", left: "0", top: "0", zIndex: "1000", width: "var(--fig-w)", maxWidth: "none" });
```

Screenshot both at the same size and look at them side by side, region by region. (React may log a hydration warning after this; it's harmless. Reload to undo.) Compare:

- text: labels, capitalization, order of buttons and columns
- spacing and alignment: padding, gaps, row heights, vertical centering in cells
- sizes: icons, font sizes, button heights, column widths
- borders and dividers: which sides, which token
- colors in both themes

Then:

- **Light**: on the docs page, `document.documentElement.classList.remove("dark")` (or the theme toggle). On the dashboard, `document.documentElement.dataset.theme = "light"` changes the view only; don't change the account's appearance setting.
- **Phone width**: resize to 390x844 and reload. The page must not scroll sideways and the figure must keep its proportions. If the control the text is about becomes unreadably small, crop tighter.
- **Highlight**: view a page that uses the figure with `highlight`, or add one temporarily. Every ring and badge is visible and unclipped.
- **Markdown**: `curl -s <docs>/docs/<slug>.md | grep Dashboard` shows `[Dashboard: <description>]`.

## Staleness: stamps and check:figures

Each figure stamps its `sources` (git blob ids, the same ids `git hash-object` prints) in `lib/dashboard-figures.stamps.json`. The token layer is stamped too, as `dashboard-figures.css`, against `apps/webapp/app/tailwind.css`.

`pnpm --filter docs-site check:figures` (also part of `check`, and run in CI on every pull request that touches `apps/webapp/app/**` or `docs/**`):

1. **Fails** on a tag that names a missing figure or mark, or has a malformed `highlight`.
2. **Warns** (a GitHub annotation in CI, never a failure) for each figure with a source file that changed, moved or was never stamped since its stamp, naming the pages that use it.

A warning means "look", not "wrong": many webapp changes don't touch what a figure shows.

### Refresh a stale figure

1. Read the warning: which figure, which files.
2. See what changed since the stamp: `git cat-file -p <stamped blob id> | diff -u - <file>` (run from the repo root), with the blob id from `lib/dashboard-figures.stamps.json`, or read the pull request's diff.
3. If the change could show in the figure (a label, a class, a column, a new button), open the screen in the dashboard and compare it with the figure as above. Update the component, the `description` and `marks` if needed, and every page whose text describes what changed.
4. If a source file moved or was split, update `sources` in the registry.
5. Re-stamp: `pnpm --filter docs-site check:figures --stamp <name>` (for the token layer, `--stamp dashboard-figures.css`, after copying the changed tokens into `app/dashboard-figures.css`). Commit the stamps with the change, even when the figure didn't need one.

Stamp only after you have compared: a stamp says "this figure matched these files".

## Gotchas from the first 54 figures

**Capturing**
- Sign in to the reference dashboard at `/login`: fill `local@trigger.dev` and press Continue with Email. It signs in directly.
- Load `capture.js` with `evaluate_script` using `format: "script"` and `sourcePath`.
- `capture.js` drops whitespace-only text segments (the " " before AM) and turns `<code>` into a plain span, losing `font-mono`. Put both back by hand.
- React Aria DateField segments carry a hidden placeholder ("mm", "––") that sets their width. Keep it even though it looks runtime-only.

**Writing the component**
- Write responsive classes (`md:`, `sm:`) at their desktop values. In the docs they resolve against the docs viewport, so a copied `md:` class changes the figure's layout on phones.
- Pin `vh` to the 1440x900 value (`max-h-[min(44rem,80vh)]` becomes `max-h-[44rem]`) and say so in the header comment. `vh` follows the docs window, not the dashboard's.
- Wide tables in a flex frame need `min-w-0` on the content column, or they push the canvas wider.
- A full-page canvas must be tall enough to show the active side-menu item above Help & Feedback, or the `nav` mark is hidden.
- Settings pages can crop to one `SettingsSection` (no side menu) at 640 wide, which keeps text close to 1:1 in the docs column.
- A `rows=3` textarea's line box is 83px, not 76px, and its placeholder uses preflight's gray-500, not `text-text-dimmed`.
- Icons only one figure uses can stay in that figure's file, which avoids merge conflicts in `icons.tsx`.
- Tabler icons: `RunIcon` draws many span names with `@tabler/icons` (`stroke-[1.5]`, inherited colour). Copy the SVG from `node_modules/.pnpm/@tabler+icons@*/**/icons/outline/` into `icons.tsx`. Names the SDK sets without a case in `RunIcon` (`cloud-upload`, `cloud-download`) draw as `InfoIcon`. Copy what the dashboard draws, not what the SDK meant.
- The trace footer switches from the inline shortcuts row to a "Shortcuts" popover at 48rem. A trace crop's width decides which one shows, so say in the header which one you kept.

**Marks**
- A badge is the marked element's `::after`, so `overflow-hidden` on the element or any ancestor clips it. Check every badge is visible at desktop and phone width. Fix it with `left` or `below`, or by dropping the ancestor's `overflow-hidden`. Inside the side-menu rail, use `below`.
- A mark on a dimmed (disabled) control fades with it. Put the mark on a wrapper outside the opacity.
- A badge on a hovered sticky cell needs `z-10` on that cell.

**Checking**
- The inject check can't compare div tables: the webapp's CSS lacks `table-header-group` and `table-row-group` (it never writes them) and arbitrary values only figures use (`max-h-[44rem]`, `h-[83px]`). Add `.table-header-group{display:table-header-group}.table-row-group{display:table-row-group}` to the page, compare row heights only, and treat other width differences as noise. The same goes for classes only the figure writes, such as a plain `translate-x-3.5` where the webapp writes `data-[state=checked]:`.
- At phone width every figure should scale to the column with no horizontal overflow. Anything else is a bug.
- Run `oxfmt` from `trigger.dev/`, the repo root inside the worktree. From the worktree's parent it fails with "Command not found", which is easy to miss when the output is silenced.

## Red flags

Check these before you call a figure done:

- A semantic tag (`<table>`, `<button>`, `<input>`, `<hr>`, `<a>`) anywhere in the component.
- A `table-cell` div without `align-middle`.
- A hex color, `rgb()`, or `charcoal-*` class that the webapp doesn't write in that place.
- Both halves of a tailwind-merge conflict in one class string (`-mx-1 ... -mx-2`, `gap-1.5 ... gap-0.5`).
- A mark inside `overflow-hidden` or `truncate`, or a ring or badge that runs off the canvas.
- The same control marked on every row of a table.
- A ring, arrow or number drawn into the figure by hand, or a mark styled differently from the highlight rule.
- Real-looking data: a customer or company name, a real person, an unmasked key, a production URL.
- A screen that looks right only in dark mode.
- Text in the figure that the dashboard doesn't show, or a control missing that it does show.
- A canvas much wider than its content, which makes the text tiny in the column.
- `sources` missing the route or a primitive the figure draws, or stamps not updated after the change.
- A description that names a control the figure doesn't show, or misses one the page tells the reader to click.

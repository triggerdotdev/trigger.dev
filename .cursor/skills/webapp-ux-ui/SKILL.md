---
name: webapp-ux-ui
description: >-
  UX and UI patterns, conventions, and design principles for the Trigger.dev
  webapp (apps/webapp). Use when building or modifying dashboard pages, designing
  component layouts, choosing UI primitives, implementing navigation, handling
  loading/error states, or making any user-facing changes to the webapp.
---

# Trigger.dev Webapp — UX & UI Guide

Living document. Patterns are extracted from real implementation work on the webapp and reflect what actually ships, not abstract ideals.

## Buttons

Always use the `Button` (or `LinkButton`) component from `~/components/primitives/Buttons`.

**Variant format:** `"{style}/{size}"` — e.g. `"secondary/small"`, `"primary/medium"`.

| Style | Usage | Limit |
|-------|-------|-------|
| `primary` | Main call-to-action | **1 per page max** |
| `secondary` | Default for most actions. Use when unsure. | No limit |
| `tertiary` | De-emphasized actions | — |
| `minimal` | Very low-prominence, inline-feeling actions | — |
| `danger` | Destructive actions (delete, revoke, etc.) | — |
| `docs` | Links out to documentation | — |

Sizes: `small`, `medium`, `large`, `extra-large`.

Menu-specific variants (`menu-item`, `small-menu-item`, `small-menu-sub-item`) exist for dropdown/menu contexts — don't use these for standalone buttons.

```tsx
<LinkButton to={href} variant="secondary/small" LeadingIcon={BellAlertIcon}>
  Configure alerts
</LinkButton>
```

## Typography

- **Ellipsis:** Always use the single ellipsis character `…` (U+2026), never three periods `...`.

> TODO: Document color tokens, spacing scale, font families.

## Layout Stability

Avoid layout shift. UI appearing or disappearing should not push neighbouring elements around.

- **Numbers:** Always apply `tabular-nums` (e.g. `font-variant-numeric: tabular-nums` / Tailwind `tabular-nums`) so digit widths stay constant as values change.
- **Conditional UI:** Prefer overlays, absolute positioning, or reserving space up front so that showing/hiding elements doesn't reflow the page.
- **When shift is unavoidable** (e.g. a warning banner that must push content down after a user action): animate the transition with `framer-motion` so the movement feels intentional, not janky.

```tsx
import { AnimatePresence, motion } from "framer-motion";

<AnimatePresence>
  {showBanner && (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <WarningBanner />
    </motion.div>
  )}
</AnimatePresence>
```

## Layout Patterns

Every page follows one of a small set of templatable layouts. Pick the right skeleton first, then fill in the content areas.

### Page Shell

All routes under `_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam` share a common shell:

```tsx
<>
  <NavBar>
    <PageTitle title="Page Name" />           {/* or backButton + title */}
    <PageAccessories>{/* buttons */}</PageAccessories>
  </NavBar>
  <PageBody scrollable={false}>
    {/* page content */}
  </PageBody>
</>
```

- `NavBar` is always the topmost element and contains `PageTitle` + optional `PageAccessories`.
- `PageBody` with `scrollable={false}` when the content manages its own scrolling (tables, resizable panels). Use `scrollable` (default) for simple flowing pages.
- For layout routes that wrap child routes, use `<PageContainer>` around `<Outlet />`.

### Template 1 — List Page (filters + table)

Used by: Errors index, Runs index, Logs, Batches, Bulk actions, Waitpoints.

```
┌─────────────────────────────────────┐
│ NavBar                              │
├─────────────────────────────────────┤
│ FiltersBar  (border-b)              │
├─────────────────────────────────────┤
│ Table (scrollable body)             │
│                                     │
└─────────────────────────────────────┘
```

```tsx
<div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
  <NavBar>...</NavBar>
  <PageBody scrollable={false}>
    <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden">
      <FiltersBar />
      <Table containerClassName="max-h-full pb-[2.5rem]">...</Table>
    </div>
  </PageBody>
</div>
```

Key conventions:
- Filter bar height is `2.5rem`. Pad with `p-2`, border with `border-b border-grid-bright`.
- Right side of filter bar: action buttons then `<ListPagination />`, wrapped in `<div className="flex shrink-0 items-center gap-2">`.
- Left side: filter chips + search, wrapped in `<div className="flex flex-row flex-wrap items-center gap-1">`.
- Outer wrapper: `flex items-start justify-between gap-x-2`.

### Template 2 — List + Conditional Right Panel

Used by: Logs, Runs index (bulk inspector), Deployments, Schedules, Batches, Bulk actions, Waitpoints.

```
┌──────────────────┬─────────────────┐
│ List / Table     │ Detail Panel    │
│ (ResizablePanel) │ (ResizablePanel)│
│                  │ conditional     │
└──────────────────┴─────────────────┘
```

The right panel appears when an item is selected (URL param, search param, etc.) and disappears when deselected.

```tsx
<ResizablePanelGroup orientation="horizontal" className="max-h-full">
  <ResizablePanel id="{page}-main" min="200px">
    {/* list content */}
  </ResizablePanel>
  {showPanel && (
    <>
      <ResizableHandle id="{page}-handle" />
      <ResizablePanel id="{page}-inspector" min="300px" default="430px" max="600px" isStaticAtRest>
        {/* detail content */}
      </ResizablePanel>
    </>
  )}
</ResizablePanelGroup>
```

Conventions:
- `isStaticAtRest` on the detail panel so it doesn't fight for space.
- Panel IDs: `{page}-main`, `{page}-handle`, `{page}-inspector` (or `{page}-detail`).
- Typical sizing: min `280–300px`, default `380–500px`, max `500–600px`.
- The detail panel has a header row (`grid-rows-[auto_1fr]`) with a close button using `ExitIcon` + `shortcut={{ key: "esc" }}`.

### Template 3 — Detail Page with Permanent Right Sidebar

Used by: Error detail, Prompts, Test tasks.

```
┌──────────────────┬─────────────────┐
│ Main content     │ Detail sidebar  │
│ (chart, table,   │ (Property.Table │
│  editor, etc.)   │  metadata, etc.)│
│ ResizablePanel   │ ResizablePanel  │
└──────────────────┴─────────────────┘
```

The right panel is always visible — it shows summary/metadata about the entity.

```tsx
<ResizablePanelGroup orientation="horizontal" className="max-h-full">
  <ResizablePanel id="{page}-main" min="300px">
    {/* primary content */}
  </ResizablePanel>
  <ResizableHandle id="{page}-detail-handle" />
  <ResizablePanel id="{page}-detail" min="280px" default="380px" max="500px" isStaticAtRest>
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
      <div className="flex items-center justify-between border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2>Details</Header2>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Property.Table>...</Property.Table>
      </div>
    </div>
  </ResizablePanel>
</ResizablePanelGroup>
```

### Template 4 — Overlay Panel (Sheet)

Used by: Error alerts configuration, Query editor (dashboards).

Content slides in from the right on top of the page. Use when the panel is transient (opened by a button, closed when done) and shouldn't affect the main layout.

```tsx
<Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
  <SheetContent
    side="right"
    className="w-[420px] min-w-[320px] max-w-[560px] p-0 sm:max-w-[560px]"
    onOpenAutoFocus={(e) => e.preventDefault()}
  >
    {/* panel content */}
  </SheetContent>
</Sheet>
```

Conventions:
- Import `Sheet`, `SheetContent` from `~/components/primitives/SheetV3`.
- Control open state via URL search params (e.g. `?alerts=true`) for link-shareability.
- `onOpenAutoFocus` with `preventDefault()` to stop auto-focusing the first input.
- The sheet content component manages its own header/footer/scroll.

### Detail Sidebar Content Pattern

Inside a right-hand sidebar (Template 2, 3, or 4), content follows this structure:

```tsx
<div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
  {/* Header */}
  <div className="flex items-center justify-between border-b border-grid-dimmed py-2 pl-3 pr-2">
    <Header2 className="truncate">Title</Header2>
    {/* optional close button for conditional panels */}
  </div>
  {/* Scrollable body */}
  <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
    <Property.Table>
      <Property.Item>
        <Property.Label>Field</Property.Label>
        <Property.Value>value</Property.Value>
      </Property.Item>
    </Property.Table>
  </div>
</div>
```

- `Property.Table` from `~/components/primitives/PropertyTable` for key-value metadata.
- Use `CopyableText` for IDs, identifiers, and values users might want to copy.
- Close button pattern: `<Button variant="minimal/small" TrailingIcon={ExitIcon} shortcut={{ key: "esc" }} />`.
- Scrollbar styling: always `scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600`.

### Sidebar Data with Property Components

Always use `Property.Table` / `Property.Item` / `Property.Label` / `Property.Value` for **all** data in sidebars — including custom content like badges, error messages, or status areas. This keeps heading styles (`font-medium text-text-bright`) consistent. **Do not** use all-caps/`uppercase` for labels, and don't recreate the heading style with raw `<span>` elements.

Put everything in **one** `Property.Table` per sidebar so spacing is uniform.

```tsx
<Property.Table>
  {/* Standard key-value */}
  <Property.Item>
    <Property.Label>Task</Property.Label>
    <Property.Value>
      <CopyableText value={taskId} />
    </Property.Value>
  </Property.Item>

  {/* Custom rich content in value */}
  <Property.Item>
    <Property.Label>Status</Property.Label>
    <Property.Value>
      <StatusBadge status={status} className="w-fit" />
    </Property.Value>
  </Property.Item>

  {/* Label with an action on the right */}
  <Property.Item>
    <div className="flex items-center justify-between">
      <Property.Label>Status</Property.Label>
      <ActionDropdown />
    </div>
    <Property.Value>
      <StatusBadge status={status} className="w-fit" />
    </Property.Value>
  </Property.Item>

  {/* Freeform content like error messages */}
  <Property.Item>
    <Property.Label>Error</Property.Label>
    <Property.Value>
      <Paragraph variant="small" className="break-words font-mono">
        {errorMessage}
      </Paragraph>
    </Property.Value>
  </Property.Item>
</Property.Table>
```

- Numeric values: always wrap in `<span className="tabular-nums">` and use `.toLocaleString()` for large numbers.
- Copyable values: use `CopyableText` inside `Property.Value`.
- Actions next to a label: wrap `Property.Label` and the action in a `flex items-center justify-between` div inside the `Property.Item`.

### Resizable Panel Conventions

Import from `~/components/primitives/Resizable`: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`.

| Prop | Usage |
|------|-------|
| `id` | Required. `{page}-main`, `{page}-detail`, `{page}-handle` |
| `min` | Always set. Prevents panel from collapsing. `"100px"`–`"300px"` typical |
| `default` | Initial size. Use px (`"430px"`) or percentage (`"50%"`) |
| `max` | Cap the panel. Only needed on detail/inspector panels |
| `isStaticAtRest` | Detail panels: prevents them from growing on window resize |
| `autosaveId` | On `ResizablePanelGroup` to persist user's resize via cookies |

## Navigation & Routing

### Back Buttons

On detail pages, use `PageTitle` with `backButton`:

```tsx
<PageTitle
  backButton={{ to: parentPath, text: "Parent Page" }}
  title={<span className="font-mono text-xs">{friendlyId}</span>}
/>
```

### URL-driven State

Prefer URL search params over React state for anything that should survive refresh or be shareable:
- Filter selections: `?tasks=foo&status=UNRESOLVED`
- Panel open/close: `?alerts=true`
- Pagination: `?cursor=xxx&direction=forward`
- Time range: `?period=1d` or `?from=123&to=456`

Use the `useSearchParams` hook from `~/hooks/useSearchParam` (not React Router's) and `useOptimisticLocation` from `~/hooks/useOptimisticLocation`.

## Data Display

### Tables

Use components from `~/components/primitives/Table`: `Table`, `TableHeader`, `TableRow`, `TableHeaderCell`, `TableBody`, `TableCell`, `CopyableTableCell`, `TableCellChevron`.

- `Table containerClassName="max-h-full pb-[2.5rem]"` for tables below a filter bar with pagination.
- `CopyableTableCell` for cells whose value should be copyable on hover.
- All numeric cells: wrap content in `<span className="tabular-nums">` or apply `className="tabular-nums"` to the `TableCell`.
- Link rows: pass `to={path}` on each `TableCell` to make the entire row clickable.

### Pagination

Use `<ListPagination list={list} />` from `~/components/ListPagination`. Place it in the right side of the filter bar or in a header row.

### Empty States

Center a message with `Header3` + `Paragraph`:

```tsx
<div className="flex h-full items-center justify-center">
  <div className="text-center">
    <Header3 className="mb-2">No items found</Header3>
    <Paragraph variant="small">Contextual help text.</Paragraph>
  </div>
</div>
```

## Loading & Error States

### Deferred Data

Use `typeddefer` in loaders + `TypedAwait` with `Suspense` in components:

```tsx
<Suspense fallback={<LoadingState />}>
  <TypedAwait resolve={data} errorElement={<ErrorState />}>
    {(result) => <Content data={result} />}
  </TypedAwait>
</Suspense>
```

### Loading Spinner

```tsx
<div className="flex items-center justify-center">
  <div className="mx-auto flex items-center gap-2">
    <Spinner />
    <Paragraph variant="small">Loading…</Paragraph>
  </div>
</div>
```

### Error Callout

```tsx
<div className="flex items-center justify-center px-3 py-12">
  <Callout variant="error" className="max-w-fit">
    Unable to load data. Please refresh the page or try again in a moment.
  </Callout>
</div>
```

## Animation & Transitions

This is a developer tool — animations should feel precise and functional, never flashy or gratuitous. Every animation must serve a purpose: orientating the user, confirming an action, or smoothing a state change.

**Library:** Use `framer-motion` for all animations. It's already a project dependency.

### Principles

- **Subtle and fast.** Durations of `0.1–0.2s` for micro-interactions, `0.15–0.3s` for layout transitions. Anything over `0.4s` needs a strong justification.
- **Purposeful.** If removing the animation doesn't hurt comprehension, remove it.
- **Consistent easing.** Prefer `ease` or `easeOut` for entrances, `easeIn` for exits. Avoid springy/bouncy physics — they feel out of place in a dev tool.
- **Respect reduced motion.** Wrap non-essential animations so they're skipped when `prefers-reduced-motion` is set.

### Common use cases

| Use case | Approach |
|----------|----------|
| Element appearing/disappearing | `AnimatePresence` + `motion.div` with opacity + height |
| Layout shift mitigation | `layout` prop on `motion.div` or explicit height animation (see Layout Stability) |
| Tab/panel switching | Crossfade via `AnimatePresence mode="wait"` |
| Loading → content | Fade in with `initial={{ opacity: 0 }}` → `animate={{ opacity: 1 }}` |
| Hover/focus feedback | CSS transitions preferred over framer-motion for simple property changes |

For detailed `framer-motion` API patterns, component recipes, and advanced usage, see the dedicated [framer-motion skill](../framer-motion/SKILL.md).

## Forms & Inputs

> TODO: Form layout, validation display, field grouping.

## Feedback & Notifications

> TODO: Toasts, inline messages, confirmation dialogs.

## Accessibility

> TODO: Focus management, keyboard nav, aria patterns.

---

## Changelog

Track when patterns are added/updated so we can see how this evolves.

| Date | Section | Change |
|------|---------|--------|
| 2026-03-26 | Animation & Transitions | Framer-motion principles, duration guidelines, common patterns |
| 2026-03-26 | Layout Patterns | 4 page templates, resizable panel conventions, sidebar content pattern |
| 2026-03-26 | Navigation | Back buttons, URL-driven state |
| 2026-03-26 | Data Display | Table conventions, pagination, empty states |
| 2026-03-26 | Loading & Error States | Deferred data, spinner, error callout patterns |
| 2026-03-26 | Typography | Use ellipsis character (…), not three periods |
| 2026-03-26 | Layout Stability | tabular-nums, avoid shift, framer-motion for unavoidable reflows |
| 2026-03-26 | Buttons | Button component variants, 1-primary-per-page rule |
| 2026-03-26 | — | Initial skeleton created |

# Prevent importing from `@trigger.dev/core` directly (`trigger-dev/no-trigger-core-import`)

<!-- end auto-generated rule header -->

Due to [this Remix bug](https://github.com/remix-run/remix/issues/9597), the web app is very sensitive to importing server-side code when it's bundling for the client side. If a route imports from a barrel file that ALSO exports server-side code, it will break the webapp's client side navigation and the page simply refreshes. This only happens during development.

## Rule Details

This rule prevents importing from `@trigger.dev/core` and `@trigger.dev/core/v3` directly, which are barrel files that export server-side code.

It forces direct imports from the most specific file that exports a particular module and will autocorrect it.

Examples of **incorrect** code for this rule:

```ts
import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
```

Examples of **correct** code for this rule:

```ts
import { ScheduledTaskPayload } from "@trigger.dev/core/v3/schemas";
import { parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3/utils/ioSerialization";
```

## When Not To Use It

This rule prevents issues when client-side navigating to routes that import from `@trigger.dev/core` or `@trigger.dev/core/v3`. If there will be no client-side navigation during development, this rule is not needed.

If [this bug](https://github.com/remix-run/remix/issues/9597) is fixed, this rule can be removed.

## Workflow

This rule runs in several steps

```ts
import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
```

First it splits Core imports into one line per import

```ts
import { ScheduledTaskPayload } from "@trigger.dev/core/v3";
import { parsePacket } from "@trigger.dev/core/v3";
import { prettyPrintPacket } from "@trigger.dev/core/v3";
```

Then refines each down to their most specific exported file

```ts
import { ScheduledTaskPayload } from "@trigger.dev/core/v3/schemas/api";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { prettyPrintPacket } from "@trigger.dev/core/v3/utils/ioSerialization";
```

if that exported file is downstream of an allowed barrel file (set to the schemas folders right now), it returns the export from the barrel instead

```ts
import { ScheduledTaskPayload } from "@trigger.dev/core/v3/schemas";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { prettyPrintPacket } from "@trigger.dev/core/v3/utils/ioSerialization";
```

then the normal lint plugin for merging multiple imports from the same file will run and merge any that are the same

```ts
import { ScheduledTaskPayload } from "@trigger.dev/core/v3/schemas";
import { parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3/utils/ioSerialization";
```

## Trigger.dev Integrations Development Guide

### JSON Schema to Zod

If you need to convert a JSON Schema to Zod, use this handy [transform.tools utility](https://transform.tools/json-schema-to-zod)

### Add a new provider configuration to pizzly

```sh
PIZZLY_HOSTPORT=http://localhost:3004 npx pizzly config:create github github <client id> <client secret> "scopes,here"
```

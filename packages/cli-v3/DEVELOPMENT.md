# Running the CLI from source

1. Run the CLI and watch for changes

```sh
cd packages/cli-v3
pnpm run dev
```

2. Test the local CLI using the job-catalogs located in the `/test-projects` directory

```sh
pnpm i
pnpm exec trigger <command>
```

---

If you want to use it in a new folder, you need to first add it as a dev dependency in package.json:

```json
//...
"devDependencies": {
    "trigger.dev": "workspace:*",
    //...
}
//...
```

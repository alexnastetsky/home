# home

The Databricks App shell. It owns the dependencies, the build, the server
process, and the deploy; the actual apps live in submodules under `apps/` and
mount themselves onto its Express instance.

| Path         | App                                       | Repo             |
| ------------ | ----------------------------------------- | ---------------- |
| `/`          | landing page (`landing/index.html`)       | this repo        |
| `/worldcup`  | 2026 World Cup prediction pool            | `apps/worldcup`  |
| `/todolist`  | collaborative todos                       | `apps/todolist`  |

<https://home-2371699704326236.aws.databricksapps.com>

Databricks Free Edition allows one app per workspace, which is why two unrelated
apps share one deployment. Each app registers its routes through
`appkit.server.extend()` and serves its own client bundle, so they never touch
each other.

## Getting started

```bash
git clone --recurse-submodules <this repo> && cd home
npm install
cp .env.example .env     # then fill in the Lakebase dev connection + DEV_USER_EMAIL
npm run build && npm run dev
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the dev loop, the submodule workflow,
and how the dev vs production databases are separated.

## How mounting works

`server/server.ts` passes each app the absolute path to its built client, then
AppKit's `StaticServer` serves `landing/` and installs the catch-all — which
runs *after* the apps' routes.

Passing `staticPath` to the `server()` plugin is load-bearing. Without it AppKit
looks for a root SPA of its own: in production it scans for `dist/index.html`,
and in development it throws outright because there is no `client/vite.config.ts`
here. Naming `landing/` explicitly skips that search in both modes.

## Deploying

```bash
npm run build && npm run ship
```

`ship` runs `databricks apps validate` then `databricks apps deploy`. The
platform builds from the uploaded source, so the client `dist/` directories are
gitignored and never shipped. `app-keepalive/` is a separate bundle (`databricks
bundle deploy` from that directory) whose hourly job restarts the app after Free
Edition's 24-hour auto-stop.

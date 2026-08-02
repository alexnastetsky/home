import path from 'node:path';
import { createApp, lakebase, server } from '@databricks/appkit';
import { setupPoolRoutes } from '../apps/worldcup/server';
import { setupTodolistRoutes } from '../apps/todolist/server';

// cwd is the repo root under both `npm run dev` and the deployed `npm run start`.
const fromRoot = (...parts: string[]) => path.resolve(process.cwd(), ...parts);

// This shell has no root SPA — just a static landing page. Passing staticPath is
// load-bearing: without it AppKit hunts for a root client, and in dev mode that
// search throws (it wants client/vite.config.ts + index.html, which we don't have).
// With it, StaticServer serves landing/ and installs the '*' fallback, which runs
// AFTER every route the apps register through server.extend().
createApp({
  plugins: [lakebase(), server({ staticPath: fromRoot('landing') })],
  async onPluginsReady(appkit) {
    await setupPoolRoutes(appkit, { distPath: fromRoot('apps/worldcup/client/dist') });
    await setupTodolistRoutes(appkit, { distPath: fromRoot('apps/todolist/client/dist') });
  },
}).catch(console.error);

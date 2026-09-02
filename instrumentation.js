// ISP-AUTO-APPROVAL + 4-DAY-FOLLOWUP batch: standard Next.js 16 App
// Router hook for "run code once when the server process boots" (see
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md --
// "export a `register` function ... called once when a new Next.js
// server instance is initiated, and must complete before the server is
// ready to handle requests"). This is the idiomatic, supported mechanism
// for starting the in-process background scheduler (lib/backgroundScheduler.js)
// exactly once per server process, with NO client/page trigger of any
// kind and NO second Docker service/process needed -- this file lives at
// the project root (required location for the instrumentation
// convention), imported by nothing else, invoked automatically by the
// Next.js runtime itself on `next start` / `next dev`.
//
// Guarded to the Node.js runtime only (this app's server code -- SQLite
// via node:sqlite, the scheduler, etc. -- is Node-only; register() is
// also invoked once for the Edge runtime in environments that have one,
// which must not attempt to import server-only modules).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundScheduler } = await import("./lib/backgroundScheduler");
    startBackgroundScheduler();
  }
}

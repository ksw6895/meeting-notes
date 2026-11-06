import fs from "node:fs";
import path from "node:path";
import open from "open";
import { startNoteWorker, stopNoteWorker } from "./note-jobs.ts";
import { forceCloseAllAudioWriters, recoverAudioJournals } from "./audio.ts";
import { startQueueWorker, stopQueueWorker } from "./queue.ts";
import { acquireInstanceLock, InstanceAlreadyRunningError } from "./instance-lock.ts";
import { clearAllReservations } from "./billing.ts";
import { DATA_DIR } from "./db.ts";

// Optional .env (OPENAI_API_KEY, PORT) next to package.json.
const envFile = path.resolve(import.meta.dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { buildApp } = await import("./app.ts");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4310);
let instanceLock: ReturnType<typeof acquireInstanceLock>;
try {
  instanceLock = acquireInstanceLock();
} catch (error) {
  if (!(error instanceof InstanceAlreadyRunningError)) throw error;
  // After a Windows shutdown the lock survives and its PID may now belong to another process.
  // If nothing answers on our port and the lock is not brand new, it is stale: take it over.
  const lockDir = path.join(DATA_DIR, ".meeting-notes.lock");
  const alive = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  const ageMs = fs.existsSync(lockDir) ? Date.now() - fs.statSync(lockDir).mtimeMs : Infinity;
  if (alive || ageMs < 60_000) {
    console.log(error.message);
    if (process.argv.includes("--open")) await open(`http://${HOST}:${PORT}`);
    process.exit(0);
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
  instanceLock = acquireInstanceLock();
}
const app = await buildApp({ staticFiles: true, port: PORT });

app.post("/api/app/shutdown", async (_request, reply) => {
  setTimeout(() => { void shutdown(); }, 100);
  return reply.code(202).send({ ok: true, message: "녹음을 저장하고 종료합니다." });
});

try {
  // Bind first: a second launch must not mutate journal or queue state merely
  // because its requested port is already occupied.
  await app.listen({ host: HOST, port: PORT });
  clearAllReservations();
  recoverAudioJournals();
  startQueueWorker();
  startNoteWorker();
  console.log(`회의록이 http://${HOST}:${PORT} 에서 실행 중입니다.`);
  if (process.argv.includes("--open")) await open(`http://${HOST}:${PORT}`);
} catch (error) {
  instanceLock.release();
  await app.close().catch(() => undefined);
  throw error;
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const workersStopped = Promise.allSettled([stopQueueWorker(), stopNoteWorker()]);
  let shutdownError: unknown;
  try { forceCloseAllAudioWriters(); } catch (error) { shutdownError = error; }
  try { await app.close(); } catch (error) { shutdownError ??= error; }
  for (const result of await workersStopped) if (result.status === 'rejected') shutdownError ??= result.reason;
  instanceLock.release();
  if (shutdownError) {
    console.error("회의록 앱 종료 중 오류:", shutdownError instanceof Error ? shutdownError.message : shutdownError);
    process.exitCode = 1;
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

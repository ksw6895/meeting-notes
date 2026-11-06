import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./db.ts";

const OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_GRACE_MS = 10_000;

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

export class InstanceAlreadyRunningError extends Error {
  readonly code = "INSTANCE_ALREADY_RUNNING";

  constructor(readonly pid?: number) {
    super(pid
      ? `회의록 앱이 이미 실행 중입니다 (PID ${pid}). 브라우저에서 http://127.0.0.1:4310 을 여세요.`
      : "회의록 앱이 이미 실행 중입니다. 브라우저에서 http://127.0.0.1:4310 을 여세요.");
    this.name = "InstanceAlreadyRunningError";
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), "utf8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.token !== "string") return undefined;
    return parsed as LockOwner;
  } catch {
    return undefined;
  }
}

function removeKnownLock(lockDir: string): void {
  fs.rmSync(path.join(lockDir, OWNER_FILE), { force: true });
  fs.rmdirSync(lockDir);
}

export interface InstanceLock {
  path: string;
  release(): void;
}

/**
 * A data-directory lock prevents a second port or development process from
 * recovering the same journals/queue concurrently. The owner PID makes a
 * crash-left lock safely reclaimable.
 */
export function acquireInstanceLock(dataDir = DATA_DIR): InstanceLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockDir = path.join(dataDir, ".meeting-notes.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readOwner(lockDir);
      if (owner && processIsAlive(owner.pid)) throw new InstanceAlreadyRunningError(owner.pid);
      const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (!owner && ageMs < INCOMPLETE_LOCK_GRACE_MS) throw new InstanceAlreadyRunningError();
      removeKnownLock(lockDir);
      continue;
    }

    const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    const ownerPath = path.join(lockDir, OWNER_FILE);
    const fd = fs.openSync(ownerPath, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    let released = false;
    return {
      path: lockDir,
      release() {
        if (released) return;
        released = true;
        const current = readOwner(lockDir);
        if (current?.token !== owner.token) return;
        removeKnownLock(lockDir);
      }
    };
  }
  throw new InstanceAlreadyRunningError();
}

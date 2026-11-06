#!/usr/bin/env node
// Starts the app in the background (installing/building on first run), then opens the browser.
// Works the same on Windows, macOS and Linux: `npm start` or the desktop shortcut (--quiet).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.PORT || 4310);
const url = `http://127.0.0.1:${port}`;
const quiet = process.argv.includes("--quiet");

// Same location as server/db.ts defaultDataDir().
function dataDir() {
  if (process.env.MEETING_NOTES_DATA_DIR) return process.env.MEETING_NOTES_DATA_DIR;
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "MeetingNotes");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "MeetingNotes");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "meeting-notes");
}
const logDir = path.join(dataDir(), "logs");
const logFile = path.join(logDir, "server.log");
fs.mkdirSync(logDir, { recursive: true });

/** A shortcut has no visible console, so tell the person in a dialog. */
function notify(message, isError = false) {
  if (!quiet) { (isError ? console.error : console.log)(message); return; }
  try {
    if (process.platform === "win32") {
      const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${message.replace(/'/g, "''")}', '회의록') | Out-Null`;
      spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("osascript", ["-e", `display dialog ${JSON.stringify(message)} with title "회의록" buttons {"확인"} default button 1${isError ? " with icon caution" : ""}`], { detached: true, stdio: "ignore" }).unref();
    } else console.log(message);
  } catch { console.log(message); }
}

async function healthy() {
  try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

async function waitForHealth(timeoutMs) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (await healthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openBrowser() {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

function npm(args) {
  // npm is a .cmd shim on Windows, which needs a shell to run. Output goes to the log when quiet.
  const out = quiet ? fs.openSync(logFile, "a") : "inherit";
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: root, stdio: ["ignore", out, out], shell: process.platform === "win32", windowsHide: true });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} 실패. 자세한 내용: ${logFile}`);
}

if (await healthy()) {
  openBrowser();
  process.exit(0);
}

// Two quick double-clicks must not run two installs/builds in the same folder.
const lock = path.join(dataDir(), ".launch.lock");
try { fs.mkdirSync(lock); }
catch {
  if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) {
    if (await waitForHealth(10 * 60_000)) openBrowser();
    process.exit(0);
  }
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
}

try {
  if (!fs.existsSync(path.join(root, "node_modules", "tsx"))) {
    notify("처음 실행이라 필요한 파일을 설치합니다. 몇 분 걸릴 수 있어요. 끝나면 브라우저가 자동으로 열립니다.");
    npm(["install"]);
  }
  const dist = path.join(root, "dist", "index.html");
  if (!fs.existsSync(dist) || newestMtime(path.join(root, "src")) > fs.statSync(dist).mtimeMs) {
    if (!quiet) console.log("화면을 빌드합니다…");
    npm(["run", "build"]);
  }

  const log = fs.openSync(logFile, "a");
  // Detached: closing this window or the browser does not stop the server.
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root, detached: true, stdio: ["ignore", log, log], windowsHide: true
  });
  child.unref();

  if (!await waitForHealth(30_000)) throw new Error(`앱 서버가 30초 안에 시작하지 않았습니다. 로그: ${logFile}`);
  if (!quiet) console.log(`회의록이 ${url} 에서 실행 중입니다.`);
  openBrowser();
} catch (error) {
  notify(`회의록을 시작하지 못했습니다.\n${error instanceof Error ? error.message : String(error)}`, true);
  process.exitCode = 1;
} finally {
  fs.rmSync(lock, { recursive: true, force: true });
}

#!/usr/bin/env node
// Saves any in-progress recording and stops the background server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const url = `http://127.0.0.1:${Number(process.env.PORT || 4310)}`;

try {
  const response = await fetch(`${url}/api/app/shutdown`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: url }, body: "{}", signal: AbortSignal.timeout(5000)
  });
  console.log(response.ok ? "회의록 앱을 종료했습니다." : `종료 요청 실패 (${response.status})`);
} catch {
  console.log("실행 중인 회의록 앱이 없습니다.");
}

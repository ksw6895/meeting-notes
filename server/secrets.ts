import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.ts";

// One provider only. Keys live in the local data folder, never in git or the browser.
export type SecretName = "openai";
const secretsFile = () => path.join(DATA_DIR, "secrets.json");

function readStore(): Partial<Record<SecretName, string>> {
  try { return JSON.parse(fs.readFileSync(secretsFile(), "utf8")); } catch { return {}; }
}

function writeStore(store: Partial<Record<SecretName, string>>): void {
  const target = secretsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  // 0600 on macOS/Linux. Windows ignores the mode; the file stays inside the user's own folder.
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function normalizeApiKey(value: string): string {
  const secret = value.trim();
  if (!/^[A-Za-z0-9_.:/+=-]+$/.test(secret) || secret.length < 20 || secret.length > 2048) {
    throw Object.assign(new Error("API 키 형식을 확인하세요. 키 전체만 붙여넣어 주세요."), { statusCode: 400 });
  }
  return secret;
}

/** The environment (or .env) wins so a shared machine can keep the key out of the data folder. */
export async function getSecret(name: SecretName): Promise<string> {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  return readStore()[name]?.trim() || "";
}

export function secretSource(): "env" | "file" | "missing" {
  if (process.env.OPENAI_API_KEY?.trim()) return "env";
  return readStore().openai ? "file" : "missing";
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (!value.trim()) return;
  writeStore({ ...readStore(), [name]: normalizeApiKey(value) });
}

export async function deleteSecret(name: SecretName): Promise<void> {
  const store = readStore();
  delete store[name];
  writeStore(store);
}

export async function validateSecret(name: SecretName, model: string): Promise<{ status: "missing" | "unchecked" | "valid" | "invalid"; message: string }> {
  const key = await getSecret(name);
  if (!key) return { status: "missing", message: "OpenAI API 키가 없습니다." };
  try {
    const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000)
    });
    if (response.ok) return { status: "valid", message: `${model} 접근을 확인했습니다.` };
    if (response.status === 401) return { status: "invalid", message: "API 키 인증에 실패했습니다 (401). 키 전체를 다시 붙여넣고 저장하세요." };
    if (response.status === 403 || response.status === 404) return { status: "unchecked", message: `${model}에 접근할 수 없습니다 (${response.status}). 프로젝트 권한이나 결제 상태를 확인하세요.` };
    return { status: "unchecked", message: `OpenAI 응답 ${response.status} 때문에 키를 확인하지 못했습니다.` };
  } catch {
    return { status: "unchecked", message: "네트워크 문제로 API 키를 확인하지 못했습니다." };
  }
}

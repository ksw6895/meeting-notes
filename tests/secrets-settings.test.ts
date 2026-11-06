import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-secrets-"));
process.env.MEETING_NOTES_DATA_DIR = tempDir;
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;

const { db, getSetting } = await import("../server/db.ts");
const secrets = await import("../server/secrets.ts");
const app = await (await import("../server/app.ts")).buildApp({ staticFiles: false });
const secretsFile = path.join(tempDir, "secrets.json");
const FILE_KEY = "sk-test-file-key-0123456789abcdef";
const ENV_KEY = "sk-test-env-key-0123456789abcdef";

beforeEach(async () => {
  delete process.env.OPENAI_API_KEY;
  fs.rmSync(secretsFile, { force: true });
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; });
afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("secret file store", () => {
  it("stores the key in DATA_DIR/secrets.json with owner-only permissions", async () => {
    expect(secrets.secretSource()).toBe("missing");
    expect(await secrets.getSecret("openai")).toBe("");
    await secrets.setSecret("openai", `  ${FILE_KEY}\n`);
    expect(JSON.parse(fs.readFileSync(secretsFile, "utf8"))).toEqual({ openai: FILE_KEY });
    if (process.platform !== "win32") expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await secrets.getSecret("openai")).toBe(FILE_KEY);
    expect(secrets.secretSource()).toBe("file");
    await secrets.setSecret("openai", "   ");
    expect(await secrets.getSecret("openai")).toBe(FILE_KEY);
    await secrets.deleteSecret("openai");
    expect(await secrets.getSecret("openai")).toBe("");
    expect(secrets.secretSource()).toBe("missing");
  });

  it("lets OPENAI_API_KEY override the stored key", async () => {
    await secrets.setSecret("openai", FILE_KEY);
    process.env.OPENAI_API_KEY = `  ${ENV_KEY} `;
    expect(await secrets.getSecret("openai")).toBe(ENV_KEY);
    expect(secrets.secretSource()).toBe("env");
    process.env.OPENAI_API_KEY = "   ";
    expect(await secrets.getSecret("openai")).toBe(FILE_KEY);
    expect(secrets.secretSource()).toBe("file");
  });

  it("treats a corrupt store as empty", async () => {
    fs.writeFileSync(secretsFile, "{not json");
    expect(await secrets.getSecret("openai")).toBe("");
    expect(secrets.secretSource()).toBe("missing");
  });

  it.each([
    ["too short", "sk-short"],
    ["contains a space", "sk-test key-0123456789abcdef"],
    ["contains a line break inside", "sk-test-0123456789\nabcdef"],
    ["contains non-ASCII", "sk-테스트-0123456789abcdef"],
    ["is too long", `sk-${"a".repeat(2_100)}`]
  ])("rejects a key that %s", async (_label, value) => {
    expect(() => secrets.normalizeApiKey(value)).toThrow(/형식/);
    await expect(secrets.setSecret("openai", value)).rejects.toMatchObject({ statusCode: 400 });
    expect(fs.existsSync(secretsFile)).toBe(false);
  });

  it("accepts project keys with the usual punctuation", () => {
    expect(secrets.normalizeApiKey(" sk-proj-AbC_123.xyz-0000000000 ")).toBe("sk-proj-AbC_123.xyz-0000000000");
  });
});

describe("validateSecret", () => {
  it("reports a missing key without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await secrets.validateSecret("openai", "gpt-transcribe")).toMatchObject({ status: "missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [200, "valid"],
    [401, "invalid"],
    [403, "unchecked"],
    [404, "unchecked"],
    [500, "unchecked"]
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await secrets.validateSecret("openai", "gpt-6.1-terra");
    expect(result.status).toBe(expected);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models/gpt-6.1-terra");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ENV_KEY}` });
  });

  it("reports network failures as unchecked", async () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await secrets.validateSecret("openai", "gpt-transcribe")).toMatchObject({ status: "unchecked" });
  });
});

describe("settings routes", () => {
  it("saves a key without ever returning it and clears it on request", async () => {
    const saved = await app.inject({ method: "PUT", url: "/api/settings", payload: { openAiKey: FILE_KEY } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(FILE_KEY);
    expect(saved.json()).toMatchObject({ openAiKeyPresent: true, openAiKeySource: "file", openAiKeyStatus: "unchecked" });
    expect(await secrets.getSecret("openai")).toBe(FILE_KEY);
    const read = await app.inject({ method: "GET", url: "/api/settings" });
    expect(read.body).not.toContain(FILE_KEY);
    expect(read.json().noteModels.map((model: any) => model.id)).toEqual(["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"]);

    const cleared = await app.inject({ method: "PUT", url: "/api/settings", payload: { clearOpenAiKey: true } });
    expect(cleared.json()).toMatchObject({ openAiKeyPresent: false, openAiKeySource: "missing", openAiKeyStatus: "missing" });
    expect(await secrets.getSecret("openai")).toBe("");
  });

  it("reports an environment key as its source without exposing it", async () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    const read = await app.inject({ method: "GET", url: "/api/settings" });
    expect(read.json()).toMatchObject({ openAiKeyPresent: true, openAiKeySource: "env" });
    expect(read.body).not.toContain(ENV_KEY);
  });

  it("rejects malformed keys with 400 and stores nothing", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/settings", payload: { openAiKey: "sk-test key with spaces 000000" } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("spaces");
    expect(fs.existsSync(secretsFile)).toBe(false);
  });

  it("rejects unknown note models without changing anything", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { liveModel: "gpt-6-luna", finalModel: "gpt-6.1-sol" } });
    for (const payload of [{ liveModel: "gpt-6.1-luna" }, { finalModel: "gemini-3.5-flash" }, { liveModel: "gpt-6.1-terra", finalModel: "unpriced-model" }]) {
      const response = await app.inject({ method: "PUT", url: "/api/settings", payload });
      expect(response.statusCode).toBe(400);
    }
    expect(getSetting("live_model")).toBe("gpt-6-luna");
    expect(getSetting("final_model")).toBe("gpt-6.1-sol");
    const ok = await app.inject({ method: "PUT", url: "/api/settings", payload: { liveModel: "gpt-6.1-terra", realtimeSttEnabled: false, krwPerUsd: 99_999 } });
    expect(ok.json()).toMatchObject({ liveModel: "gpt-6.1-terra", finalModel: "gpt-6.1-sol", realtimeSttEnabled: false, krwPerUsd: 5_000 });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { realtimeSttEnabled: true } });
  });

  it("validates the key against every configured model and stores the result", async () => {
    process.env.OPENAI_API_KEY = ENV_KEY;
    await app.inject({ method: "PUT", url: "/api/settings", payload: { liveModel: "gpt-6-luna", finalModel: "gpt-6-luna", realtimeSttEnabled: true } });
    const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const validated = await app.inject({ method: "POST", url: "/api/settings/validate", payload: {} });
    expect(validated.json().results.openai.status).toBe("valid");
    expect(fetchMock.mock.calls.map(([url]) => String(url).split("/").pop()).sort()).toEqual(["gpt-6-luna", "gpt-live-transcribe", "gpt-transcribe"]);
    expect(validated.json().settings.openAiKeyStatus).toBe("valid");
    expect(validated.body).not.toContain(ENV_KEY);

    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("{}", { status: String(url).endsWith("gpt-live-transcribe") ? 404 : 200 })));
    const partial = await app.inject({ method: "POST", url: "/api/settings/validate", payload: {} });
    expect(partial.json().results.openai.status).toBe("unchecked");
    expect(partial.json().results.openai.message).toContain("gpt-live-transcribe");
    expect(getSetting("openai_key_status")).toBe("unchecked");
  });
});

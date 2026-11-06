import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./db.ts";
import { registerMeetings } from "./meetings.ts";
import { registerApi } from "./api.ts";

export async function buildApp(options: { staticFiles?: boolean; port?: number } = {}) {
  const port = options.port ?? 4310;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "warn" }, bodyLimit: 2 * 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; media-src 'self'; img-src 'self' data:");
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    // DNS-rebinding guard: a page on another domain that resolves to 127.0.0.1 still sends its own Host.
    const hostname = String(request.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return reply.code(403).send({ error: "허용되지 않은 Host입니다." });
    const origin = request.headers.origin;
    if (!origin) return;
    const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:5173", "http://localhost:5173"]);
    if (!allowed.has(origin)) return reply.code(403).send({ error: "허용되지 않은 Origin입니다." });
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500 && process.env.NODE_ENV !== "test") console.error(error);
    reply.code(statusCode).send({ error: error.message || "서버 오류가 발생했습니다." });
  });
  await registerApi(app);
  await registerMeetings(app);
  const distDir = path.join(ROOT_DIR, "dist");
  if (options.staticFiles !== false && fs.existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/ws") || request.url.startsWith("/assets/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

// api/index.js — entrée Vercel Serverless
// Node 22 (node:sqlite embarqué). Toutes les routes → handleRequest.
import handler from "../server/index.js";

export default async function vercelHandler(req, res) {
  try {
    // Vercel peut passer l'URL relative sans host
    if (!req.headers.host) {
      req.headers.host = process.env.VERCEL_URL || "localhost";
    }
    await handler(req, res);
  } catch (err) {
    console.error("vercel handler:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: err?.message || "erreur interne" }));
    }
  }
}

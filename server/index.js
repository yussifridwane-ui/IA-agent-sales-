// server/index.js — serveur HTTP principal (Node >= 18, zéro dépendance npm)
// Exportable pour Vercel (api/index.js) et démarrable en local via `npm start`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { db } from "./db.js";
import {
  parseCookies, isSecureRequest, clientIp,
} from "./security.js";
import { getSessionUser, csrfToken, checkCsrf } from "./auth.js";
import * as publicRoutes from "./routes/public.js";
import * as appRoutes from "./routes/app.js";
import * as settingsRoutes from "./routes/settings.js";
import * as crmRoutes from "./routes/crm.js";
import * as aiRoutes from "./routes/ai.js";
import * as smartRoutes from "./routes/smart.js";
import * as automationRoutes from "./routes/automation.js";
import * as channelRoutes from "./routes/channels.js";
import { handleMockApi } from "./routes/channels.js";
import * as inboxRoutes from "./routes/inbox.js";
import * as webchatRoutes from "./routes/webchat.js";
import * as quotesRoutes from "./routes/quotes.js";
import * as ordersRoutes from "./routes/orders.js";
import * as paymentsRoutes from "./routes/payments.js";
import * as billingRoutes from "./routes/billing.js";
import { handleWebhooks } from "./webhooks.js";
import { tick as automationTick } from "./automation/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(join(__dirname, "..", "public"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// Secret de session : obligatoire en production, éphémère en développement.
let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === "production" && !IS_SERVERLESS) {
    console.error("✖ SESSION_SECRET est obligatoire en production (voir .env.example).");
    process.exit(1);
  }
  // Sur Vercel sans secret configuré : secret dérivé (instable entre cold starts —
  // configurer SESSION_SECRET dans le dashboard Vercel pour la prod réelle).
  SESSION_SECRET = process.env.VERCEL
    ? crypto.createHash("sha256").update(`vercel-${process.env.VERCEL_URL || "local"}`).digest("hex")
    : crypto.randomBytes(32).toString("hex");
  if (!process.env.VERCEL) {
    console.warn("⚠  SESSION_SECRET non défini — secret éphémère (mode développement uniquement).");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100 * 1024) throw Object.assign(new Error("payload trop volumineux"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") parsed.__rawBody = raw;
      return parsed;
    } catch {
      throw Object.assign(new Error("JSON invalide"), { status: 400 });
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const p = new URLSearchParams(raw);
    return Object.fromEntries(p.entries());
  }
  return {};
}

/** En-têtes communs : preview Arena (iframe) + pas de cache agressif. */
function baseHeaders(extra = {}) {
  return {
    "Content-Security-Policy": "frame-ancestors *",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = resolve(join(PUBLIC_DIR, normalize(rel)));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + "/")) {
    res.writeHead(403, baseHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    return res.end("Interdit");
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, baseHeaders({
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=60",
    }));
    res.end(data);
  } catch {
    throw Object.assign(new Error("introuvable"), { status: 404 });
  }
}

function notFound(res, json) {
  if (json) {
    res.writeHead(404, baseHeaders({ "Content-Type": "application/json; charset=utf-8" }));
    return res.end(JSON.stringify({ error: "introuvable" }));
  }
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>404 · AI Sales Agent</title><link rel="stylesheet" href="/style.css"/></head>
<body class="auth-page"><div class="auth-card"><h1>404</h1><p class="muted">Cette page n'existe pas (ou plus).</p>
<a class="btn primary block" href="/">Retour à l'accueil</a></div></body></html>`;
  res.writeHead(404, baseHeaders({ "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) }));
  return res.end(html);
}

/** Handler HTTP unique (local + Vercel serverless). */
export async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const json = req.headers["x-requested-with"] === "fetch" || (req.headers["content-type"] || "").includes("application/json");
  const method = req.method === "HEAD" ? "GET" : req.method;
  const isHead = req.method === "HEAD";

  try {
    const body = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method || "") ? await readBody(req) : {};

    const auth = getSessionUser(db, req);
    let org = null;
    let member = null;
    if (auth) {
      const m = db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(auth.session.workspace_id, auth.user.id);
      if (m) {
        member = m;
        org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(m.organization_id);
      }
    }

    const csrf = auth ? csrfToken(auth.session, SESSION_SECRET) : "";

    const ctx = {
      req, res, db,
      method, path,
      query: Object.fromEntries(url.searchParams),
      body, json,
      user: auth?.user || null,
      session: auth?.session || null,
      org, member,
      csrf,
      ip: clientIp(req),
      secure: isSecureRequest(req),
      sendJSON(status, obj) {
        const out = JSON.stringify(obj);
        const headers = baseHeaders({
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(out),
          "Cache-Control": "no-store",
        });
        res.writeHead(status, headers);
        res.end(isHead ? undefined : out);
      },
      sendHTML(status, html) {
        const bodyHtml = String(html ?? "");
        const headers = baseHeaders({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(bodyHtml),
          "Cache-Control": "no-store",
        });
        res.writeHead(status, headers);
        res.end(isHead ? undefined : bodyHtml);
      },
      redirect(loc) {
        if (json) ctx.sendJSON(200, { redirect: loc });
        else {
          res.writeHead(302, baseHeaders({ Location: loc, "Cache-Control": "no-store" }));
          res.end();
        }
      },
    };

    const CSRF_EXEMPT = new Set(["/api/login", "/api/register", "/api/forgot-password", "/api/reset-password"]);
    if (req.method === "POST" && path.startsWith("/api/") && auth && !CSRF_EXEMPT.has(path)) {
      const provided = req.headers["x-csrf-token"] || body._csrf || "";
      if (!checkCsrf(provided, csrf)) {
        if (json) return ctx.sendJSON(403, { error: "Jeton CSRF invalide." });
        throw Object.assign(new Error("Jeton CSRF invalide."), { status: 403 });
      }
    }

    const isApi = path.startsWith("/api/") || path.startsWith("/demo/api/")
      || (path.startsWith("/quote/") && req.method !== "GET" && req.method !== "HEAD");

    const handlers = isApi
      ? [handleWebhooks, paymentsRoutes.handleWebhook, handleMockApi, webchatRoutes.handleApi, quotesRoutes.handlePublicApi, billingRoutes.handleApi, publicRoutes.handleApi, crmRoutes.handleApi, aiRoutes.handleApi, smartRoutes.handleApi, automationRoutes.handleApi, channelRoutes.handleApi, inboxRoutes.handleApi, quotesRoutes.handleApi, ordersRoutes.handleApi, paymentsRoutes.handleApi, appRoutes.handleApi, settingsRoutes.handleApi]
      : null;
    const pages = !isApi && method === "GET"
      ? [publicRoutes.handlePage, crmRoutes.handlePage, aiRoutes.handlePage, automationRoutes.handlePage, channelRoutes.handlePage, inboxRoutes.handlePage, webchatRoutes.handlePage, quotesRoutes.handlePage, ordersRoutes.handlePage, billingRoutes.handlePage, appRoutes.handlePage, settingsRoutes.handlePage]
      : null;

    if (handlers) {
      for (const h of handlers) {
        const handled = await h(ctx);
        if (handled !== false) return;
      }
      return notFound(res, true);
    }

    if (pages) {
      for (const h of pages) {
        const handled = await h(ctx);
        if (handled !== false) return;
      }
    }

    // Assets statiques (CSS/JS) — aussi servis par Vercel `public/` si présent
    if (method === "GET") {
      if (
        path === "/style.css" || path === "/app.js" || path === "/landing.js" ||
        path === "/crm.js" || path === "/ai.js" || path === "/automation.js" ||
        path.startsWith("/demo/chat") || path.startsWith("/images/")
      ) {
        if (isHead) {
          const ext = extname(path) || ".html";
          res.writeHead(200, baseHeaders({
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Cache-Control": "public, max-age=60",
          }));
          return res.end();
        }
        return await serveStatic(res, path);
      }
    }

    return notFound(res, false);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    if (path.startsWith("/api/")) {
      res.writeHead(status, baseHeaders({ "Content-Type": "application/json; charset=utf-8" }));
      return res.end(JSON.stringify({ error: err?.message || "erreur interne" }));
    }
    if (json) {
      res.writeHead(status, baseHeaders({ "Content-Type": "application/json; charset=utf-8" }));
      return res.end(JSON.stringify({ error: err?.message || "erreur interne" }));
    }
    if ((path === "/register" || path === "/api/register" || path === "/login" || path === "/api/login") && (err?.field || err?.status === 401 || err?.status === 409)) {
      try {
        const { registerPage, loginPage } = await import("./views/auth.js");
        const isRegister = path.includes("register");
        const html = isRegister ? registerPage({ error: { field: err.field, message: err.message }, values: {} }) : loginPage({ error: err.message });
        res.writeHead(err.status || 400, baseHeaders({ "Content-Type": "text/html; charset=utf-8" }));
        return res.end(html);
      } catch { /* fallthrough */ }
    }
    res.writeHead(status, baseHeaders({ "Content-Type": "text/html; charset=utf-8" }));
    return res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"/><title>Erreur</title><link rel="stylesheet" href="/style.css"/></head>
<body class="auth-page"><div class="auth-card"><h1>Erreur</h1><p class="muted">${String(err?.message || "Une erreur est survenue.")}</p>
<a class="btn primary block" href="/">Retour à l'accueil</a></div></body></html>`);
  }
}

// ---- Local server : uniquement si lancé directement (`node server/index.js`) ----
// Sur Vercel, api/index.js importe le handler sans démarrer d'écouteur.
const isDirectRun = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!IS_SERVERLESS && isDirectRun) {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("erreur interne");
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`✅ AI Sales Agent démarré : http://${HOST}:${PORT}`);
  });

  const TICK_MS = Math.max(5000, Number(process.env.AUTOMATION_TICK_MS || 30000));
  let tickBusy = false;
  setInterval(async () => {
    if (tickBusy) return;
    tickBusy = true;
    try { await automationTick(db); } catch (e) { console.error("automation tick :", e?.message || e); }
    finally { tickBusy = false; }
  }, TICK_MS).unref?.();
}

export default handleRequest;

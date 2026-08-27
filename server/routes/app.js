// server/routes/app.js — dashboard, pages placeholder + démo de conversation
import { dashboardPage, placeholderPage } from "../views/app.js";
import { createAgent } from "../../agent/engine.js";
import { saveLead, loadLeads } from "../../agent/store.js";
import { resolve, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = resolve(join(__dirname, "..", "..", "public", "demo"));

// Conversations de la démo (en mémoire, par conversationId)
const demoConversations = new Map();

function getDemoAgent(conversationId) {
  const id = String(conversationId || "default");
  if (!demoConversations.has(id)) demoConversations.set(id, createAgent());
  if (demoConversations.size > 300) {
    const oldest = demoConversations.keys().next().value;
    if (oldest !== id) demoConversations.delete(oldest);
  }
  return demoConversations.get(id);
}

function requireOrg(ctx) {
  if (!ctx.user) {
    if (ctx.json) return ctx.sendJSON(401, { error: "Connexion requise." });
    ctx.redirect("/login");
    return null;
  }
  if (!ctx.org || !ctx.member) {
    if (ctx.json) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
    ctx.redirect("/login");
    return null;
  }
  if (!ctx.org.onboarding_completed) {
    ctx.redirect("/onboarding");
    return null;
  }
  return ctx.org;
}

// Anciens chemins (placeholders Phase 1) → redirections vers les pages Phase 2/3
const LEGACY_REDIRECTS = {
  "/sales/leads": "/dashboard/leads",
  "/sales/contacts": "/dashboard/contacts",
  "/sales/deals": "/dashboard/deals",
  "/commerce/products": "/dashboard/products",
  "/commerce/orders": "/dashboard/orders",
  "/ai/agent": "/dashboard/agent",
  "/ai/conversations": "/dashboard/conversations",
  "/ai/knowledge": "/dashboard/knowledge",
};

export async function handlePage(ctx) {
  const { path, method } = ctx;
  if (method !== "GET") return false;

  if (LEGACY_REDIRECTS[path]) {
    ctx.redirect(LEGACY_REDIRECTS[path]);
    return true;
  }

  if (path === "/dashboard/diagnostics") {
    if (!requireOrg(ctx)) return true;
    const { runDiagnostics } = await import("../diagnostics.js");
    const { diagnosticsPage } = await import("../views/diagnostics.js");
    const report = runDiagnostics(ctx.db, { org: ctx.org, userId: ctx.user.id });
    return ctx.sendHTML(200, diagnosticsPage({
      user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf, report,
    }));
  }

  if (path === "/demo/chat") {
    try {
      const data = await readFile(join(DEMO_DIR, "chat.html"));
      return ctx.sendHTML(200, data.toString("utf8"));
    } catch {
      return ctx.sendHTML(404, "<h1>404</h1>");
    }
  }

  if (
    [
      "/automation/automations", "/analytics",
    ].includes(path)
  ) {
    if (!requireOrg(ctx)) return;
    return ctx.sendHTML(200, placeholderPage({ user: ctx.user, org: ctx.org, path, role: ctx.member.role, csrf: ctx.csrf }));
  }

  return false;
}

export async function handleApi(ctx) {
  const { path, method } = ctx;

  if (method === "GET" && path === "/api/diagnostics") {
    if (!requireOrg(ctx)) return true;
    const { runDiagnostics } = await import("../diagnostics.js");
    return ctx.sendJSON(200, runDiagnostics(ctx.db, { org: ctx.org, userId: ctx.user.id }));
  }

  /* ---------- Démo de conversation (moteur Phase 0, conservée) ---------- */
  if (method === "POST" && path === "/demo/api/chat") {
    const { conversationId, message } = ctx.body;
    if (typeof message !== "string" || !message.trim()) return ctx.sendJSON(400, { error: "message requis" });
    const agent = getDemoAgent(conversationId);
    const result = agent.handle(message);
    return ctx.sendJSON(200, { conversationId: String(conversationId || "default"), ...result });
  }
  if (method === "POST" && path === "/demo/api/leads") {
    const { conversationId, name, email, phone } = ctx.body;
    if (!email || !String(email).includes("@")) return ctx.sendJSON(400, { error: "e-mail requis" });
    const agent = getDemoAgent(conversationId);
    agent.attachLead({ name: name || null, email: String(email), phone: phone || null });
    const result = agent.confirmLead();
    await saveLead({ name: name || null, email: String(email).toLowerCase(), phone: phone || null, conversationId: String(conversationId || "default") });
    return ctx.sendJSON(200, { ...result, conversationId: String(conversationId || "default") });
  }
  if (method === "POST" && path === "/demo/api/reset") {
    const { conversationId } = ctx.body;
    const agent = getDemoAgent(conversationId);
    const result = agent.reset();
    return ctx.sendJSON(200, { ...result, conversationId: String(conversationId || "default") });
  }
  if (method === "GET" && path === "/demo/api/leads") {
    return ctx.sendJSON(200, { leads: await loadLeads() });
  }

  return false;
}

// server/routes/channels.js — Phase 6 : API des canaux officiels
// Connexions (config masquée), test d'envoi, historique des messages,
// identifiants plateforme des clients, canal préféré des leads.

import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import { randomUUID } from "node:crypto";
import {
  CHANNEL_DEFS, maskConfig, parseConfig, getConnection, allConnections,
  upsertConnection, disconnectConnection, sendOnChannel, bestChannelForLead,
  getMessageStatus,
} from "../channels/index.js";
import { orgWidgetKey } from "../channels/inbound.js";
import { mock, resetMock } from "../channels/transport.js";
import { checkLimit } from "../billing.js";
import { channelsPage } from "../views/channels.js";

const isTestEnv = () => process.env.APP_ENV === "test";

/* ---------- Pilotage du transport mock (UNIQUEMENT en APP_ENV=test) ---------- */
export async function handleMockApi(ctx) {
  const { path, method, body } = ctx;
  if (!isTestEnv()) return false; // 404 en production : le mock n'existe pas
  if (method === "POST" && path === "/api/channels/mock-config") {
    if (body.reset) { mock.httpRequests.length = 0; mock.smtpDialogues.length = 0; } // PAS de resetMock() (effacerait la config)
    mock.config = {
      verifyStatus: body.verifyStatus ?? null,
      verifyError: body.verifyError ?? null,
      sendStatus: body.sendStatus ?? null,
      sendError: body.sendError ?? null,
      smtpStatus: body.smtpStatus ?? null,
      smtpError: body.smtpError ?? null,
    };
    return ctx.sendJSON(200, { message: "Mock configuré." });
  }
  if (method === "POST" && path === "/api/channels/mock-reset") {
    resetMock();
    return ctx.sendJSON(200, { message: "Mock réinitialisé." });
  }
  if (method === "GET" && path === "/api/channels/mock-requests") {
    const n = Number(ctx.query.n) || 100;
    return ctx.sendJSON(200, {
      httpRequests: mock.httpRequests.slice(-n).map((r) => ({ method: r.method, url: r.url, token: r.token, body: r.body })),
      smtpDialogues: mock.smtpDialogues.slice(-n),
    });
  }
  return false;
}

const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function scopedOrg(ctx) {
  const requested = ctx.query.organization_id;
  if (requested) {
    const m = isUuid(requested) ? ctx.db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(requested, ctx.user.id) : null;
    if (!m) return { org: null, member: null, forbidden: true };
    const org = ctx.db.prepare("SELECT * FROM organizations WHERE id = ?").get(requested);
    if (!org) return { org: null, member: null, forbidden: true };
    return { org, member: m, forbidden: false };
  }
  if (!ctx.org || !ctx.member) return { org: null, member: null, forbidden: true };
  return { org: ctx.org, member: ctx.member, forbidden: false };
}

function connectionView(c) {
  const cfg = parseConfig(c.config);
  return {
    id: c.id,
    channel: c.channel,
    label: CHANNEL_DEFS[c.channel]?.label || c.channel,
    status: c.status,
    display_name: c.display_name,
    config: maskConfig(cfg),
    has_verify_token: !!cfg.verify_token,
    has_webhook_secret: !!cfg.webhook_secret,
    last_error: c.last_error,
    last_checked_at: c.last_checked_at,
    connected_at: c.connected_at,
  };
}

export async function handlePage(ctx) {
  const { path } = ctx;
  if (path !== "/dashboard/channels") return false;
  if (!ctx.user || !ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  if (!can(ctx.member.role, "automation:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
  const conns = allConnections(ctx.db, ctx.org.id).map(connectionView);
  const messages = ctx.db.prepare(
    `SELECT cm.*, l.name AS lead_name FROM channel_messages cm LEFT JOIN leads l ON l.id = cm.lead_id
     WHERE cm.organization_id = ? ORDER BY cm.created_at DESC LIMIT 100`
  ).all(ctx.org.id);
  const agent = ctx.db.prepare("SELECT ai_handling_mode FROM agent_settings WHERE organization_id = ?").get(ctx.org.id);
  const origin = `${ctx.secure ? "https" : "http"}://${ctx.req?.headers?.host || "votre-domaine.com"}`;
  return ctx.sendHTML(200, channelsPage({ user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf, connections: conns, messages, CHANNELS: Object.keys(CHANNEL_DEFS), widgetKey: orgWidgetKey(ctx.db, ctx.org.id), defaultMode: (agent?.ai_handling_mode || "AI").toUpperCase(), origin }));
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  if (!path.startsWith("/api/channels") && !path.startsWith("/api/customers/") && !/\/api\/leads\/[0-9a-f-]+\/(preferred-channel|channel-routing)$/.test(path)) return false;
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  const { org, member, forbidden } = scopedOrg(ctx);
  if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
  const read = can(member.role, "automation:read");
  const manage = can(member.role, "automation:manage");

  /* ---------- Connexions ---------- */
  if (path === "/api/channels" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    return ctx.sendJSON(200, {
      channels: allConnections(db, org.id).map(connectionView),
      available: Object.keys(CHANNEL_DEFS),
    });
  }
  const connRoute = path.match(/^\/api\/channels\/([a-z_]+)(\/test|\/messages|\/message-status)?$/i);
  if (connRoute) {
    const channel = connRoute[1].toUpperCase();
    if (!CHANNEL_DEFS[channel]) return ctx.sendJSON(404, { error: "Canal inconnu." });
    const sub = (connRoute[2] || "").toLowerCase();
    if ((method === "PUT" || method === "POST") && !sub) {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      // Phase 8 — limite du plan (canaux connectés) — WEBCHAT est intégré (jamais compté)
      if (channel !== "WEBCHAT") {
        const limCh = checkLimit(db, org.id, "channels");
        if (!limCh.ok) return ctx.sendJSON(403, { error: limCh.error, plan: limCh.plan, limit: limCh.limit, used: limCh.used });
      }
      const r = await upsertConnection(db, org.id, channel, body);
      if (r.error) return ctx.sendJSON(400, { error: r.error });
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CHANNEL_UPSERT", resourceType: "channel", resourceId: channel, metadata: { status: r.status } });
      return ctx.sendJSON(200, { ...r, message: r.status === "CONNECTED" ? "Canal connecté et vérifié." : "Canal enregistré (vérification en échec)." });
    }
    if (method === "DELETE" && !sub) {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      if (!disconnectConnection(db, org.id, channel)) return ctx.sendJSON(404, { error: "Canal non connecté." });
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CHANNEL_DISCONNECT", resourceType: "channel", resourceId: channel });
      return ctx.sendJSON(200, { message: "Canal déconnecté." });
    }
    if (method === "POST" && sub === "/test") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const to = String(body.to || "").trim();
      const text = String(body.message || "Test de connexion — AI Sales Agent.");
      if (!to) return ctx.sendJSON(400, { error: "Adresse de test (to) requise." });
      const r = await sendOnChannel(db, { orgId: org.id, channel, lead: null, to: to, subject: "Test", text });
      if (r.status === "failed") return ctx.sendJSON(200, { status: "failed", error: r.error });
      return ctx.sendJSON(200, { status: "sent", message: "Message de test envoyé (vérifiez la boîte de réception)." });
    }
    if (method === "GET" && sub === "/messages") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare(
        `SELECT cm.*, l.name AS lead_name FROM channel_messages cm LEFT JOIN leads l ON l.id = cm.lead_id
         WHERE cm.organization_id = ? AND cm.channel = ? ORDER BY cm.created_at DESC LIMIT 200`
      ).all(org.id, channel);
      return ctx.sendJSON(200, { messages: rows });
    }
    /* ---------- Statut de livraison réel (spec Phase 6 « getMessageStatus ») ----------
       Renvoie le statut JOURNALISÉ par le fournisseur (receipts). Jamais de
       DELIVERED/READ inventé : null si aucun accusé reçu. */
    if (method === "GET" && sub === "/message-status") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const providerMessageId = String(ctx.query.provider_message_id || "");
      if (!providerMessageId) return ctx.sendJSON(400, { error: "provider_message_id requis." });
      const st = getMessageStatus(db, org.id, providerMessageId);
      // Renseignement honnête : statut réel ou absence d'accusé (pas de statuts fabriqués)
      return ctx.sendJSON(200, {
        provider_message_id: providerMessageId,
        status: st ? st.status : null,
        updated_at: st ? st.updated_at : null,
        confirmed_by_provider: !!st,
        note: st ? "Statut reçu du fournisseur (receipt)." : "Aucun accusé de réception reçu du fournisseur — statuts DELIVERED/READ non confirmés.",
      });
    }
  }

  /* ---------- Clé publique du widget webchat (spec Phase 6 « Webchat widget ») ---------- */
  if (path === "/api/channels/WEBCHAT/widget-key" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const key = orgWidgetKey(db, org.id);
    const proto = ctx.secure ? "https" : "http";
    const host = ctx.req?.headers?.host || "votre-domaine.com";
    return ctx.sendJSON(200, {
      widget_key: key,
      widget_url: `/widget?k=${key}`,
      widget_url_full: `${proto}://${host}/widget?k=${key}`,
      // Identifiant PUBLIC — aucune clé secrète n'est exposée dans ce snippet.
      embed_snippet: `<iframe src="${proto}://${host}/widget?k=${key}" width="380" height="560" style="border:0;border-radius:14px" title="Chat"></iframe>`,
    });
  }

  /* ---------- Identifiants plateforme (clients) ---------- */
  const platformIds = path.match(/^\/api\/customers\/([0-9a-f-]+)\/platform-ids$/i);
  if (platformIds && method === "POST") {
    if (!can(member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const customer = isUuid(platformIds[1]) ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(platformIds[1], org.id) : null;
    if (!customer) return ctx.sendJSON(404, { error: "Client introuvable." });
    const prev = parseConfig(customer.platform_ids);
    const next = { ...prev };
    if (body.facebook !== undefined) next.facebook = body.facebook ? String(body.facebook).slice(0, 64) : null;
    if (body.instagram !== undefined) next.instagram = body.instagram ? String(body.instagram).slice(0, 64) : null;
    db.prepare("UPDATE customers SET platform_ids = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), new Date().toISOString(), customer.id);
    return ctx.sendJSON(200, { platform_ids: next, message: "Identifiants plateforme mis à jour." });
  }

  /* ---------- Canal préféré (leads) ---------- */
  const pref = path.match(/^\/api\/leads\/([0-9a-f-]+)\/preferred-channel$/i);
  if (pref && method === "PUT") {
    if (!can(member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const lead = isUuid(pref[1]) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(pref[1], org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const ch = String(body.channel || "").toUpperCase();
    if (ch && !["WHATSAPP", "EMAIL", "FACEBOOK_MESSENGER", "INSTAGRAM", "WEBCHAT"].includes(ch)) return ctx.sendJSON(400, { error: "Canal inconnu." });
    db.prepare("UPDATE leads SET preferred_channel = ?, updated_at = ? WHERE id = ?").run(ch || null, new Date().toISOString(), lead.id);
    return ctx.sendJSON(200, { preferred_channel: ch || null, message: "Canal préféré mis à jour." });
  }

  /* ---------- Routage (meilleur canal pour un lead) ---------- */
  const routing = path.match(/^\/api\/leads\/([0-9a-f-]+)\/channel-routing$/i);
  if (routing && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const lead = isUuid(routing[1]) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(routing[1], org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const best = bestChannelForLead(db, org.id, lead);
    return ctx.sendJSON(200, { lead_id: lead.id, preferred_channel: lead.preferred_channel || null, best_channel: best });
  }

  return false;
}

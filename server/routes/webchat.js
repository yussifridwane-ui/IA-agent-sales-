// server/routes/webchat.js — Phase 6 : widget webchat public
// - /widget?k=<widget_key> : page publique (aucune session, aucun secret exposé)
// - /api/widget/config, /api/widget/conversation, /api/widget/send : API du widget
//   scoping par la CLÉ PUBLIQUE de l'organisation (jamais un secret), visitor_id
//   (device, généré côté visiteur) + session_id (visite) fournis par le client.
// Règles : rate limiting par visiteur, messages bornés, jamais de retour de
// secrets / autres organisations, réponse selon le HANDLING MODE (AI/HUMAN/HYBRID).

import { createRateLimiter } from "../security.js";
import { logAudit } from "../audit.js";
import { orgWidgetKey, orgByWidgetKey, processInbound, findOrCreateConversation } from "../channels/inbound.js";
import { getAgentSettings } from "../ai/engine.js";
import { widgetPage } from "../views/widget.js";

// Limites widget (anti-abus) : par visiteur, glissant.
const widgetRate = createRateLimiter();
const WIDGET_PER_MIN = 30;
const WIDGET_PER_DAY = 400;
const visitorDayRate = createRateLimiter();

const nowIso = () => new Date().toISOString();

function publicConversationView(db, orgId, convId, visitorId, sessionId) {
  // Seules les conversations WEBCHAT sont exposées au widget (jamais les
  // conversations WhatsApp / e-mail / Messenger — pas de fuite par ID).
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ? AND channel = 'WEBCHAT'").get(convId, orgId);
  if (!conv) return null;
  // Séparation des espaces : une visite ne voit que SA propre conversation.
  if (visitorId && conv.widget_visitor_id && conv.widget_visitor_id !== visitorId) return null;
  const messages = db.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE conversation_id = ? AND role IN ('USER','ASSISTANT')
     ORDER BY created_at ASC, rowid ASC LIMIT 200`
  ).all(conv.id);
  const suggested = db.prepare("SELECT COUNT(*) n FROM suggested_replies WHERE conversation_id = ? AND status = 'PENDING'").get(conv.id).n;
  return {
    conversation_id: conv.id,
    channel: conv.channel,
    status: conv.status,
    handling_mode: conv.handling_mode || "AI",
    suggested_pending: suggested,
    messages: messages.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000), created_at: m.created_at })),
    last_message_at: conv.last_message_at,
  };
}

export async function handlePage(ctx) {
  const { path, query } = ctx;
  if (path !== "/widget") return false;
  const key = String(query.k || "");
  const org = orgByWidgetKey(ctx.db, key);
  // La page existe aussi sans clé (pour afficher un message honnête au lieu d'une 404 brouillonne)
  if (ctx.method === "GET") {
    const agent = org ? getAgentSettings(ctx.db, org.id) : null;
    return ctx.sendHTML(200, widgetPage({ org, agent, key, validKey: !!org }));
  }
  return ctx.sendHTML(405, "<h1>405</h1>");
}

export async function handleApi(ctx) {
  const { path, method, body, db, query } = ctx;
  if (!path.startsWith("/api/widget/")) return false;

  const key = String(query.k || body?.k || "");
  const org = orgByWidgetKey(db, key);
  if (!org) return ctx.sendJSON(404, { error: "Widget introuvable." });

  /* ---------- Configuration publique (jamais de secret) ---------- */
  if (method === "GET" && path === "/api/widget/config") {
    const agent = getAgentSettings(db, org.id);
    return ctx.sendJSON(200, {
      org_name: org.name,
      agent_name: agent.name || "Assistant",
      language: agent.language || "fr",
      welcome_message: agent.welcome_message || `Bonjour 👋, comment puis-je vous aider ?`,
      // clé publique UNIQUEMENT — aucune information sensible
      widget_key: orgWidgetKey(db, org.id),
      version: 1,
    });
  }

  /* ---------- Identification visiteur (opaque, bornée) ---------- */
  const visitorId = String(query.visitor_id || body?.visitor_id || "").slice(0, 64);
  const sessionId = String(query.session_id || body?.session_id || "").slice(0, 64);
  const visitorOk = /^[a-zA-Z0-9_-]{8,64}$/.test(visitorId) && /^[a-zA-Z0-9_-]{8,64}$/.test(sessionId);
  if (!visitorOk) return ctx.sendJSON(400, { error: "visitor_id et session_id requis (8-64 caractères alphanumériques)." });

  /* ---------- Conversation du visiteur ---------- */
  if (method === "GET" && path === "/api/widget/conversation") {
    const convId = String(query.conversation_id || "");
    if (convId) {
      const view = publicConversationView(db, org.id, convId, visitorId, sessionId);
      if (!view) return ctx.sendJSON(404, { error: "Conversation introuvable." });
      return ctx.sendJSON(200, view);
    }
    // Création (ou reprise) de la conversation de la visite
    const conv = findOrCreateConversation(db, { orgId: org.id, channel: "WEBCHAT", visitorId, sessionId });
    return ctx.sendJSON(200, publicConversationView(db, org.id, conv.id, visitorId, sessionId));
  }

  /* ---------- Envoi d'un message (handling modes) ---------- */
  if (method === "POST" && path === "/api/widget/send") {
    const message = String(body?.message || "").trim().slice(0, 2000);
    if (!message) return ctx.sendJSON(400, { error: "message requis" });
    // Rate limiting par visiteur (anti-abus public)
    const rmin = widgetRate(`w:min:${org.id}:${visitorId}`, WIDGET_PER_MIN, 60e3);
    const rday = visitorDayRate(`w:day:${org.id}:${visitorId}`, WIDGET_PER_DAY, 24 * 3600e3);
    if (!rmin || !rday) {
      return ctx.sendJSON(429, { error: "Trop de messages — merci d'attendre un instant." });
    }
    const convId = String(body?.conversation_id || "");
    let conv = convId ? db.prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ? AND channel = 'WEBCHAT'").get(convId, org.id) : null;
    // Vérification de propriété : on ne touche que SA propre conversation
    if (conv && conv.widget_visitor_id && conv.widget_visitor_id !== visitorId) conv = null;
    if (!conv) conv = findOrCreateConversation(db, { orgId: org.id, channel: "WEBCHAT", visitorId, sessionId, leadId: null });

    const res = await processInbound(db, {
      org, channel: "WEBCHAT", externalContactId: null,
      visitorId, sessionId, text: message, notify: true,
    });
    logAudit(db, { organizationId: org.id, userId: null, action: "WIDGET_MESSAGE", resourceType: "conversation", resourceId: conv.id, metadata: { mode: res.mode, auto_replied: res.auto_replied, channel: "WEBCHAT" } });
    const status = db.prepare("SELECT status FROM conversations WHERE id = ?").get(conv.id)?.status || "ACTIVE";
    return ctx.sendJSON(200, {
      conversation_id: res.conversation_id || conv.id,
      status,
      reply: res.auto_replied ? res.reply : (res.visitor_ack || null),
      auto_replied: res.auto_replied,
      mode: res.mode,
      suggested_pending: res.mode === "HYBRID" && res.suggested_id ? true : null,
      // Le client rechargera la conversation (polling) pour voir les réponses
      // approuvées (HYBRID) ou envoyées par un humain (HUMAN).
    });
  }

  return false;
}

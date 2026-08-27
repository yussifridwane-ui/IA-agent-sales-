// server/routes/inbox.js — Phase 6 : Boîte de réception unifiée (omnicanal)
// /dashboard/inbox + /api/inbox — toutes les conversations (webchat, e-mail,
// WhatsApp, Messenger, Instagram) dans une seule vue, avec :
//  - filtres : Tous, Non lus, Assignés à moi, IA, Humain, Hybride, Leads chauds, Urgents
//  - par conversation : nom, canal, dernier message, date, score, intention,
//    priorité, assignataire, mode de traitement, suggestions en attente
//  - actions : répondre (envoi réel sur le canal), assigner, changer le mode,
//    marquer lu, approuver/rejeter les réponses suggérées (HYBRID)
// Permissions : crm:read (lecture) / crm:write (actions).
// Statuts de livraison : jamais inventés (getMessageStatus renvoie le statut
// réel journalisé par le fournisseur via les receipts).

import { randomUUID } from "node:crypto";
import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import { sendOnChannel } from "../channels/index.js";
import { HANDLING_MODES } from "../channels/inbound.js";
import { inboxPage } from "../views/inbox.js";

const nowIso = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function safeParse(s) { try { return JSON.parse(s || "{}") || {}; } catch { return {}; } }

const EXTERNAL_CHANNELS = ["WHATSAPP", "EMAIL", "FACEBOOK_MESSENGER", "INSTAGRAM", "SMS"];

function conversationBaseQuery(db, orgId) {
  return db.prepare(
    `SELECT c.*, l.name AS lead_name, l.score AS lead_score, l.status AS lead_status,
            cu.first_name AS cust_first, cu.last_name AS cust_last,
            u.first_name AS assignee_first, u.last_name AS assignee_last,
            (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, rowid DESC LIMIT 1) AS last_content,
            (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, rowid DESC LIMIT 1) AS last_direction,
            (SELECT m.metadata FROM messages m WHERE m.conversation_id = c.id AND m.role = 'USER' ORDER BY m.created_at DESC, rowid DESC LIMIT 1) AS last_user_meta,
            (SELECT COUNT(*) FROM suggested_replies s WHERE s.conversation_id = c.id AND s.status = 'PENDING') AS suggested_pending
     FROM conversations c
     LEFT JOIN leads l ON l.id = c.lead_id AND l.organization_id = ?
     LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.organization_id = ?
     LEFT JOIN users u ON u.id = c.assigned_to
     WHERE c.organization_id = ?
     ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
     LIMIT 500`
  ).all(orgId, orgId, orgId);
}

function priorityOf(row) {
  const meta = safeParse(row.last_user_meta);
  const intent = meta.intent;
  const urgency = meta.extracted?.urgency === true;
  if (intent === "COMPLAINT" || intent === "HUMAN_REQUEST" || urgency) return "URGENT";
  if ((row.lead_score || 0) >= 81 || row.lead_status === "HOT") return "HIGH";
  if ((row.lead_score || 0) >= 61) return "MEDIUM";
  return "LOW";
}

function rowName(row) {
  if (row.lead_name) return row.lead_name;
  if (row.cust_first || row.cust_last) return `${row.cust_first || ""} ${row.cust_last || ""}`.trim();
  if (row.external_contact_id) return String(row.external_contact_id).length > 40 ? row.external_contact_id.slice(0, 37) + "…" : row.external_contact_id;
  if (row.widget_visitor_id) return `Visiteur ${String(row.widget_visitor_id).slice(-6)}`;
  return "Conversation";
}

function rowView(row) {
  const mode = HANDLING_MODES.includes(String(row.handling_mode || "").toUpperCase()) ? String(row.handling_mode).toUpperCase() : "AI";
  return {
    id: row.id,
    name: rowName(row),
    channel: row.channel,
    status: row.status,
    handling_mode: mode,
    last_message: String(row.last_content || "").slice(0, 200),
    last_direction: row.last_direction || null,
    last_message_at: row.last_message_at,
    unread_count: row.unread_count || 0,
    score: row.lead_score || null,
    lead_status: row.lead_status || null,
    intent: safeParse(row.last_user_meta).intent || null,
    priority: priorityOf(row),
    assigned_to: row.assigned_to || null,
    assignee_name: row.assigned_to ? `${row.assignee_first || ""} ${row.assignee_last || ""}`.trim() || null : null,
    suggested_pending: row.suggested_pending || 0,
    external_contact_id: row.external_contact_id || null,
  };
}

const FILTERS = {
  ALL: (r) => true,
  UNREAD: (r) => (r.unread_count || 0) > 0,
  ASSIGNED: (r, ctx) => r.assigned_to === ctx.userId,
  AI: (r) => r.handling_mode === "AI",
  HUMAN: (r) => r.handling_mode === "HUMAN",
  HYBRID: (r) => r.handling_mode === "HYBRID",
  HOT: (r) => (r.lead_score || 0) >= 81 || r.lead_status === "HOT",
  URGENT: (r) => priorityOf(r) === "URGENT" || ((r.lead_score || 0) >= 81 && (r.unread_count || 0) > 0),
};

function getConversation(ctx, id) {
  if (!isUuid(id)) return null;
  return ctx.db.prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) || null;
}

/** Dernier message entrant de la conversation (pour le threading e-mail). */
function lastInbound(db, convId) {
  return db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? AND role = 'USER'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(convId) || null;
}

/** Envoi humain depuis l'inbox : insertion + envoi réel sur le canal (échec honnête). */
async function sendHumanReply(ctx, { conv, content, subject, suggestedId = null }) {
  const db = ctx.db;
  const ch = String(conv.channel || "WEBCHAT").toUpperCase();
  const msgId = randomUUID();
  const inbound = lastInbound(db, conv.id);
  // Phase 6 — threading e-mail : le sortant est rattaché au thread (thread_id)
  const threadId = ch === "EMAIL" ? (inbound?.thread_id || inbound?.in_reply_to || inbound?.external_message_id || null) : null;
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, metadata, channel, direction, delivery_status, thread_id, created_at)
     VALUES (?, ?, 'ASSISTANT', ?, ?, ?, 'OUTBOUND', 'SENT', ?, ?)`
  ).run(msgId, conv.id, String(content).slice(0, 4000),
    JSON.stringify({ source: "inbox_human", suggested_id: suggestedId, channel: ch, subject: subject || null }),
    ch, threadId, nowIso());
  db.prepare("UPDATE conversations SET last_message_at = ?, updated_at = ?, unread_count = 0 WHERE id = ?").run(nowIso(), nowIso(), conv.id);

  if (!EXTERNAL_CHANNELS.includes(ch)) return { status: "sent", error: null, channel: ch };
  const lead = conv.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(conv.lead_id, ctx.org.id) : null;
  const toAddress = ch === "EMAIL" ? (conv.external_contact_id || lead?.email || null)
    : ch === "WHATSAPP" ? (lead?.phone || conv.external_contact_id || null)
    : conv.external_contact_id || null;
  const inReplyTo = inbound?.external_message_id || null;
  const references = inbound ? [...(inbound.email_references ? String(inbound.email_references).split(/\s+/).filter(Boolean) : []), ...(inbound.external_message_id ? [inbound.external_message_id] : [])].slice(-5).join(" ") : null;
  let subj = subject || null;
  if (ch === "EMAIL" && !subj) {
    const inMeta = safeParse(inbound?.metadata);
    subj = inMeta.subject ? `Re: ${String(inMeta.subject).slice(0, 180)}` : "Votre demande";
  }
  return sendOnChannel(db, {
    orgId: ctx.org.id, channel: ch, lead: lead || { id: null }, to: toAddress,
    subject: subj || "Votre demande", text: String(content).slice(0, 4000),
    emailHeaders: inReplyTo ? { in_reply_to: inReplyTo, references } : null,
  });
}

export async function handlePage(ctx) {
  const { path } = ctx;
  if (path !== "/dashboard/inbox") return false;
  if (!ctx.user || !ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403 — Permission insuffisante</h1>"); return true; }
  const rows = conversationBaseQuery(ctx.db, ctx.org.id).map(rowView);
  const counts = {
    ALL: rows.length,
    UNREAD: rows.filter((r) => r.unread_count > 0).length,
    ASSIGNED: rows.filter((r) => r.assigned_to === ctx.user.id).length,
    AI: rows.filter((r) => r.handling_mode === "AI").length,
    HUMAN: rows.filter((r) => r.handling_mode === "HUMAN").length,
    HYBRID: rows.filter((r) => r.handling_mode === "HYBRID").length,
    HOT: rows.filter((r) => (r.score || 0) >= 81 || r.lead_status === "HOT").length,
    URGENT: rows.filter((r) => r.priority === "URGENT" || ((r.score || 0) >= 81 && r.unread_count > 0)).length,
  };
  const members = ctx.db.prepare(
    `SELECT u.id, u.first_name, u.last_name FROM organization_members om JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = ? AND om.status = 'active' AND om.role != 'VIEWER' ORDER BY u.first_name`
  ).all(ctx.org.id);
  return ctx.sendHTML(200, inboxPage({ user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf, counts, members }));
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  if (!path.startsWith("/api/inbox")) return false;
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
  // Scope multi-tenant : ?organization_id=… n'est accepté que si l'utilisateur
  // EST membre de cette organisation — sinon 403 (jamais de fuite par l'ID).
  const requestedOrg = ctx.query.organization_id;
  if (requestedOrg) {
    const m = isUuid(requestedOrg) ? db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(requestedOrg, ctx.user.id) : null;
    const o = m ? db.prepare("SELECT * FROM organizations WHERE id = ?").get(requestedOrg) : null;
    if (!m || !o) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    ctx.org = o;
    ctx.member = m;
  }

  /* ---------- Liste + filtres ---------- */
  if (method === "GET" && path === "/api/inbox") {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const filter = String(ctx.query.filter || "ALL").toUpperCase();
    const fn = FILTERS[filter] || FILTERS.ALL;
    const rows = conversationBaseQuery(db, ctx.org.id)
      .filter((r) => fn(r, { userId: ctx.user.id }))
      .map(rowView);
    return ctx.sendJSON(200, { filter, conversations: rows, count: rows.length });
  }

  /* ---------- Détail conversation ---------- */
  const detail = path.match(/^\/api\/inbox\/conversations\/([0-9a-f-]+)$/i);
  if (detail && method === "GET") {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const conv = getConversation(ctx, detail[1]);
    if (!conv) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    const messages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 300").all(conv.id);
    const suggested = db.prepare("SELECT * FROM suggested_replies WHERE conversation_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 5").all(conv.id);
    const lead = conv.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(conv.lead_id, ctx.org.id) : null;
    const session = safeParse(conv.metadata);
    return ctx.sendJSON(200, {
      conversation: { ...rowView({ ...conv, last_content: null, last_direction: null, last_user_meta: null, lead_name: null, cust_first: null, cust_last: null, assignee_first: null, assignee_last: null }), status: conv.status },
      messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, channel: m.channel, direction: m.direction, delivery_status: m.delivery_status, external_message_id: m.external_message_id, thread_id: m.thread_id, metadata: safeParse(m.metadata), created_at: m.created_at })),
      suggested_replies: suggested.map((s) => ({ id: s.id, content: s.content, rationale: s.rationale, confidence: s.confidence, status: s.status, created_at: s.created_at })),
      lead: lead ? { id: lead.id, name: lead.name, score: lead.score, status: lead.status, next_best_action: lead.next_best_action, next_best_action_reason: lead.next_best_action_reason, phone: lead.phone, email: lead.email, assigned_to: lead.assigned_to } : null,
      // Aides pour le mode HUMAIN (résumé déterministe — jamais de statistique inventée)
      summary: {
        besoin: session.need || session.product || null,
        budget: session.budget ?? null,
        objections: session.objections || [],
        urgence: session.urgency || false,
        message_count: messages.length,
        last_intent: session.last_intent || null,
      },
    });
  }

  /* ---------- Marquer lu ---------- */
  const readRoute = path.match(/^\/api\/inbox\/conversations\/([0-9a-f-]+)\/read$/i);
  if (readRoute && method === "POST") {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const conv = getConversation(ctx, readRoute[1]);
    if (!conv) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    db.prepare("UPDATE conversations SET unread_count = 0 WHERE id = ?").run(conv.id);
    return ctx.sendJSON(200, { message: "Conversation marquée comme lue." });
  }

  /* ---------- Mise à jour : assignation / mode / statut ---------- */
  const updateRoute = path.match(/^\/api\/inbox\/conversations\/([0-9a-f-]+)$/i);
  if (updateRoute && method === "PUT") {
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const conv = getConversation(ctx, updateRoute[1]);
    if (!conv) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    const errors = [];
    let assignedTo = conv.assigned_to;
    if (body.assigned_to !== undefined) {
      if (body.assigned_to === null || body.assigned_to === "") assignedTo = null;
      else {
        const m = isUuid(body.assigned_to) ? db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'").get(ctx.org.id, body.assigned_to) : null;
        if (!m) errors.push("assignée à un inconnu (membre actif requis)");
        else assignedTo = m.user_id;
      }
    }
    let mode = conv.handling_mode;
    if (body.handling_mode !== undefined) {
      const m2 = String(body.handling_mode || "").toUpperCase();
      if (!HANDLING_MODES.includes(m2)) errors.push("handling_mode invalide (AI, HUMAN ou HYBRID)");
      else mode = m2;
    }
    let status = conv.status;
    if (body.status !== undefined) {
      if (!["ACTIVE", "RESOLVED", "HANDOFF"].includes(String(body.status))) errors.push("statut invalide (ACTIVE, RESOLVED, HANDOFF)");
      else status = String(body.status);
    }
    if (errors.length) return ctx.sendJSON(400, { error: errors.join(" ") });
    db.prepare("UPDATE conversations SET assigned_to = ?, handling_mode = ?, status = ?, updated_at = ? WHERE id = ?").run(assignedTo, mode, status, nowIso(), conv.id);
    logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "INBOX_CONVERSATION_UPDATE", resourceType: "conversation", resourceId: conv.id, metadata: { assigned_to: assignedTo, handling_mode: mode, status } });
    return ctx.sendJSON(200, { message: "Conversation mise à jour.", assigned_to: assignedTo, handling_mode: mode, status });
  }

  /* ---------- Réponse humaine (envoi réel sur le canal) ---------- */
  const replyRoute = path.match(/^\/api\/inbox\/conversations\/([0-9a-f-]+)\/reply$/i);
  if (replyRoute && method === "POST") {
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const conv = getConversation(ctx, replyRoute[1]);
    if (!conv) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    const message = String(body.message || "").trim();
    if (!message) return ctx.sendJSON(400, { error: "message requis" });
    const r = await sendHumanReply(ctx, { conv, content: message, subject: body.subject ? String(body.subject).slice(0, 200) : null });
    logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "INBOX_REPLY", resourceType: "conversation", resourceId: conv.id, metadata: { channel: conv.channel, status: r.status } });
    if (r.status === "failed") return ctx.sendJSON(200, { status: "failed", error: r.error, message: "Le message est enregistré dans la conversation mais l'envoi sur le canal a échoué (statut honnête).", conversation_id: conv.id });
    return ctx.sendJSON(200, { status: "sent", message: "Réponse envoyée.", conversation_id: conv.id });
  }

  /* ---------- Réponses suggérées (HYBRID) : approuver / rejeter ---------- */
  const suggRoute = path.match(/^\/api\/inbox\/suggested\/([0-9a-f-]+)\/(approve|reject)$/i);
  if (suggRoute && method === "POST") {
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const sug = isUuid(suggRoute[1]) ? db.prepare("SELECT * FROM suggested_replies WHERE id = ? AND organization_id = ?").get(suggRoute[1], ctx.org.id) : null;
    if (!sug) return ctx.sendJSON(404, { error: "Suggestion introuvable." });
    if (sug.status !== "PENDING") return ctx.sendJSON(409, { error: `Suggestion déjà ${sug.status.toLowerCase()} (statut : ${sug.status}).` });
    const conv = db.prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ?").get(sug.conversation_id, ctx.org.id);
    if (!conv) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    if (suggRoute[2] === "reject") {
      db.prepare("UPDATE suggested_replies SET status = 'REJECTED', reviewed_by = ?, resolved_at = ? WHERE id = ?").run(ctx.user.id, nowIso(), sug.id);
      logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "SUGGESTED_REJECTED", resourceType: "suggested_reply", resourceId: sug.id });
      return ctx.sendJSON(200, { message: "Suggestion rejetée.", status: "REJECTED" });
    }
    const content = String(body.content || sug.content).trim();
    if (!content) return ctx.sendJSON(400, { error: "Contenu requis pour envoyer." });
    const r = await sendHumanReply(ctx, { conv, content, suggestedId: sug.id });
    db.prepare("UPDATE suggested_replies SET status = 'SENT', content = ?, reviewed_by = ?, resolved_at = ? WHERE id = ?").run(content, ctx.user.id, nowIso(), sug.id);
    logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "SUGGESTED_APPROVED", resourceType: "suggested_reply", resourceId: sug.id, metadata: { send_status: r.status } });
    if (r.status === "failed") return ctx.sendJSON(200, { status: "sent_failed", error: r.error, message: "Suggestion approuvée : enregistrée dans la conversation, mais l'envoi sur le canal a échoué (statut honnête).", conversation_id: conv.id });
    return ctx.sendJSON(200, { status: "sent", message: "Suggestion approuvée et envoyée.", conversation_id: conv.id });
  }

  return false;
}

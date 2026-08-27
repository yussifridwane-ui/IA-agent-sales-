// server/channels/inbound.js — Phase 6 : traitement unifié des messages entrants
// (webhooks canaux officiels + widget webchat) et GATING des handling modes.
//
// Handling modes (spec Phase 6) :
//  - AI     : l'IA répond automatiquement SI et SEULEMENT SI toutes les conditions
//             sont réunies : canal connecté + org autorisé (agent ACTIVE) + mode AI
//             + confiance suffisante + pas d'opt-out + limites de communication.
//             Toute condition en échec → AUCUNE réponse IA, l'équipe est notifiée.
//  - HUMAN  : l'IA ne répond JAMAIS automatiquement. Le visiteur/client reçoit une
//             attente ; l'humain répond depuis l'inbox (résumé + aides dans l'inbox).
//  - HYBRID : l'IA prépare une réponse SUGGÉRÉE (suggested_replies, statut PENDING) ;
//             l'humain édite/approuve/renvoie/rejette depuis l'inbox.
//
// Jamais de réponse inventée : si un envoi externe échoue, l'échec est journalisé
// et signalé — jamais transformé en succès.

import { randomUUID } from "node:crypto";
import { getConnection } from "./index.js";
import { getPreferences } from "../automation/followup.js";
import { getAgentSettings } from "../ai/engine.js";
import { notifyUser, notifiableMembers } from "../automation/engine.js";
import { logAudit } from "../audit.js";

const now = () => new Date().toISOString();

/* ---------- Modes par défaut (organisation) ---------- */
export const HANDLING_MODES = ["AI", "HUMAN", "HYBRID"];

export function orgDefaultMode(db, orgId) {
  const a = db.prepare("SELECT ai_handling_mode FROM agent_settings WHERE organization_id = ?").get(orgId);
  const m = String(a?.ai_handling_mode || "AI").toUpperCase();
  return HANDLING_MODES.includes(m) ? m : "AI";
}

/* ---------- Widget : clé publique ---------- */
/** Clé publique du widget (générée à la demande, jamais un secret). */
export function orgWidgetKey(db, orgId) {
  const org = db.prepare("SELECT widget_key FROM organizations WHERE id = ?").get(orgId);
  if (org?.widget_key) return org.widget_key;
  const key = randomUUID().replace(/-/g, "").slice(0, 20);
  db.prepare("UPDATE organizations SET widget_key = ?, updated_at = ? WHERE id = ?").run(key, now(), orgId);
  return key;
}

export function orgByWidgetKey(db, key) {
  if (!key || !/^[a-zA-Z0-9]{12,32}$/.test(String(key))) return null;
  return db.prepare("SELECT * FROM organizations WHERE widget_key = ?").get(String(key)) || null;
}

/* ---------- Conversation : recherche / création ---------- */
/**
 * Trouve ou crée la conversation unifiée pour un contact entrant.
 *  - canaux externes : (org, channel, external_contact_id)
 *  - webchat         : (org, channel WEBCHAT, widget_visitor_id, widget_session_id)
 *  - sinon           : première conversation du lead
 */
export function findOrCreateConversation(db, { orgId, channel, externalContactId = null, visitorId = null, sessionId = null, leadId = null }) {
  const ch = String(channel || "WEBCHAT").toUpperCase();
  if (externalContactId) {
    const c = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = ? AND external_contact_id = ? ORDER BY created_at DESC LIMIT 1").get(orgId, ch, String(externalContactId).slice(0, 160));
    if (c) return c;
  }
  if (ch === "WEBCHAT" && visitorId && sessionId) {
    const c = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND channel = 'WEBCHAT' AND widget_visitor_id = ? AND widget_session_id = ? ORDER BY created_at DESC LIMIT 1").get(orgId, String(visitorId).slice(0, 64), String(sessionId).slice(0, 64));
    if (c) return c;
  }
  if (leadId) {
    const c = db.prepare("SELECT * FROM conversations WHERE organization_id = ? AND lead_id = ? AND channel = ? ORDER BY updated_at DESC LIMIT 1").get(orgId, leadId, ch);
    if (c) return c;
  }
  const id = randomUUID();
  const mode = orgDefaultMode(db, orgId);
  db.prepare(
    `INSERT INTO conversations (id, organization_id, channel, status, handling_mode, external_contact_id, widget_visitor_id, widget_session_id, lead_id, last_message_at, metadata, created_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, '{}', ?, ?)`
  ).run(id, orgId, ch, mode, externalContactId ? String(externalContactId).slice(0, 160) : null,
    ch === "WEBCHAT" ? String(visitorId || "").slice(0, 64) || null : null,
    ch === "WEBCHAT" ? String(sessionId || "").slice(0, 64) || null : null,
    leadId || null, now(), now(), now());
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

/* ---------- Gating : peut l'IA répondre automatiquement ? ---------- */
/**
 * Vérifie TOUTES les conditions d'auto-réponse (spec Phase 6 « AI Mode »).
 * Renvoie { ok, reasons[] } — ok=false ⇒ aucune réponse IA, équipe notifiée.
 */
export function autoReplyGates(db, { orgId, channel, lead = null, conversation = null }) {
  const reasons = [];
  const ch = String(channel || "WEBCHAT").toUpperCase();
  if (ch !== "WEBCHAT") {
    const conn = getConnection(db, orgId, ch);
    if (!conn || conn.status !== "CONNECTED") reasons.push(`Canal ${ch} non connecté.`);
  }
  const agent = getAgentSettings(db, orgId);
  if (agent.status !== "ACTIVE") reasons.push("Agent IA non activé (org non autorisé à l'auto-réponse).");
  if (lead) {
    const prefs = getPreferences(db, orgId, lead);
    const chFlag = { WHATSAPP: "whatsapp", EMAIL: "email", SMS: "sms" }[ch] || null;
    if (!prefs.marketing && chFlag !== null) reasons.push("Opt-out du prospect (communication désactivée).");
    if (chFlag && !prefs[chFlag]) reasons.push(`Opt-out du canal ${ch}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Notifie l'équipe (membres non VIEWER, déduplicata 24 h géré par notifyUser). */
export function notifyInbound(db, { orgId, type, title, message = null, link = null, leadId = null, excludeUserId = null }) {
  try {
    for (const m of notifiableMembers(db, orgId, excludeUserId)) {
      notifyUser(db, { orgId, userId: m.user_id, type, title, message, link, leadId });
    }
  } catch { /* non bloquant */ }
}

/* ---------- Enregistrement du message USER (modes sans appel IA) ---------- */
function recordUserMessage(db, { conversation, text, channel, externalMessageId = null, inReplyTo = null, emailReferences = null, externalContactId = null, subject = null }) {
  const id = randomUUID();
  const ch = String(channel || conversation.channel || "WEBCHAT").toUpperCase();
  const refs = emailReferences ? String(emailReferences).split(/\s+/).filter(Boolean) : [];
  const threadId = ch === "EMAIL" ? (inReplyTo || refs[0] || externalMessageId || null) : null;
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, metadata, channel, direction, external_message_id, thread_id, in_reply_to, email_references, external_contact_id, created_at)
     VALUES (?, ?, 'USER', ?, ?, ?, 'INBOUND', ?, ?, ?, ?, ?, ?)`
  ).run(id, conversation.id, String(text || "").slice(0, 4000), JSON.stringify({ source: "inbound_manual", channel: ch, subject: subject || null }),
    ch,
    externalMessageId ? String(externalMessageId).slice(0, 255) : null,
    threadId ? String(threadId).slice(0, 255) : null,
    inReplyTo ? String(inReplyTo).slice(0, 255) : null,
    emailReferences ? String(emailReferences).slice(0, 1000) : null,
    externalContactId ? String(externalContactId).slice(0, 160) : null, now());
  return id;
}

const ACK = {
  HUMAN: "Merci pour votre message. Notre équipe le consulte et vous répondra dès que possible.",
  HYBRID: "Notre équipe est en train de préparer votre réponse. Elle vous sera transmise très rapidement.",
};

/**
 * Point d'entrée unifié : traite un message entrant selon le handling mode.
 *
 * params : { org, conn, channel, lead, externalContactId, visitorId, sessionId,
 *            text, emailMeta?: { subject, messageId, inReplyTo, references }, userId? }
 * retour : { mode, auto_replied, reply?, suggested_id?, gate_reasons?, send? }
 *   - send : résultat de l'envoi externe (canal ≠ WEBCHAT, mode AI)
 */
export async function processInbound(db, { org, conn = null, channel, lead = null, externalContactId = null, visitorId = null, sessionId = null, text, emailMeta = null, userId = null, notify = true }) {
  const orgId = org.id;
  const ch = String(channel || "WEBCHAT").toUpperCase();
  const conversation = findOrCreateConversation(db, { orgId, channel: ch, externalContactId, visitorId, sessionId, leadId: lead?.id || null });

  // Le message entrant compte comme « non lu » tant qu'un humain (ou l'IA en mode AI) ne l'a pas traité.
  db.prepare("UPDATE conversations SET unread_count = unread_count + 1, last_message_at = ?, updated_at = ?, external_contact_id = COALESCE(external_contact_id, ?), lead_id = COALESCE(lead_id, ?), channel_conversation_id = COALESCE(channel_conversation_id, ?) WHERE id = ?")
    .run(now(), now(), externalContactId || null, lead?.id || null, null, conversation.id);

  const mode = HANDLING_MODES.includes(String(conversation.handling_mode || "").toUpperCase())
    ? String(conversation.handling_mode).toUpperCase()
    : orgDefaultMode(db, orgId);
  const meta = emailMeta || {};
  const link = `/dashboard/inbox?conversation=${conversation.id}`;

  const sendExternal = async (replyText) => {
    // Envoi réel sur le canal externe (échec honnête journalisé)
    const { sendOnChannel } = await import("./index.js");
    const leadRow = lead || (conversation.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(conversation.lead_id, orgId) : null);
    const subject = meta.subject ? `Re: ${String(meta.subject).slice(0, 200)}` : "Votre demande";
    return sendOnChannel(db, {
      orgId, channel: ch, lead: leadRow || { id: null },
      to: externalContactId || (ch === "EMAIL" ? leadRow?.email : null),
      subject, text: replyText,
      emailHeaders: meta.messageId ? { in_reply_to: meta.messageId, references: [ ...(meta.references ? String(meta.references).split(/\s+/).filter(Boolean) : []), meta.messageId ].slice(-5).join(" ") } : null,
    });
  };

  /* ---------- HUMAN : l'IA ne répond jamais ---------- */
  if (mode === "HUMAN") {
    recordUserMessage(db, { conversation, text, channel: ch, externalMessageId: meta.messageId, inReplyTo: meta.inReplyTo, emailReferences: meta.references, externalContactId, subject: meta.subject });
    if (notify) {
      logAudit(db, { organizationId: orgId, userId, action: "INBOUND_HUMAN_MODE", resourceType: "conversation", resourceId: conversation.id, metadata: { channel: ch } });
      notifyInbound(db, { orgId, type: "INBOX_NEW_MESSAGE", title: `Nouveau message (${ch.toLowerCase()}) — mode humain`, message: `Le client a écrit : ${String(text || "").slice(0, 140)}`, link: conversation.lead_id ? `/dashboard/inbox?conversation=${conversation.id}` : "/dashboard/inbox", leadId: conversation.lead_id || null });
    }
    return { mode: "HUMAN", auto_replied: false, conversation_id: conversation.id, visitor_ack: ACK.HUMAN };
  }

  /* ---------- AI / HYBRID : conditions d'auto-réponse (spec Phase 6) ---------- */
  const gates = autoReplyGates(db, { orgId, channel: ch, lead: lead || (conversation.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(conversation.lead_id, orgId) : null), conversation });
  const leadRow = lead || (conversation.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(conversation.lead_id, orgId) : null);

  if (mode === "AI" && !gates.ok) {
    // Conditions non réunies : AUCUNE réponse IA (jamais contournée)
    recordUserMessage(db, { conversation, text, channel: ch, externalMessageId: meta.messageId, inReplyTo: meta.inReplyTo, emailReferences: meta.references, externalContactId, subject: meta.subject });
    logAudit(db, { organizationId: orgId, userId, action: "AUTO_REPLY_BLOCKED", resourceType: "conversation", resourceId: conversation.id, metadata: { channel: ch, reasons: gates.reasons.map((r) => r.slice(0, 120)) } });
    if (notify) notifyInbound(db, { orgId, type: "AUTO_REPLY_BLOCKED", title: `Auto-réponse IA bloquée (${ch.toLowerCase()})`, message: gates.reasons.join(" "), link, leadId: conversation.lead_id || null });
    return { mode: "AI", auto_replied: false, gate_reasons: gates.reasons, conversation_id: conversation.id, visitor_ack: ch === "WEBCHAT" ? ACK.HUMAN : null };
  }

  if (mode === "HYBRID" && !gates.ok) {
    // Pas de réponse suggérée non plus si les conditions de base échouent
    recordUserMessage(db, { conversation, text, channel: ch, externalMessageId: meta.messageId, inReplyTo: meta.inReplyTo, emailReferences: meta.references, externalContactId, subject: meta.subject });
    if (notify) notifyInbound(db, { orgId, type: "AUTO_REPLY_BLOCKED", title: `Réponse suggérée non générée (${ch.toLowerCase()})`, message: gates.reasons.join(" "), link, leadId: conversation.lead_id || null });
    return { mode: "HYBRID", auto_replied: false, gate_reasons: gates.reasons, conversation_id: conversation.id, visitor_ack: ch === "WEBCHAT" ? ACK.HUMAN : null };
  }

  /* ---------- Appel du moteur IA ---------- */
  const { agentChat } = await import("../ai/engine.js");
  const freshConv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversation.id);
  const result = await agentChat({ db, org, user: userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(userId) || null : null }, freshConv, String(text || ""), {
    suggested: mode === "HYBRID",
    inbound: { channel: ch, externalContactId, externalMessageId: meta.messageId, inReplyTo: meta.inReplyTo, emailReferences: meta.references, subject: meta.subject },
  });

  /* ---------- HYBRID : suggestion en attente d'approbation humaine ---------- */
  if (mode === "HYBRID") {
    if (result.suggested?.id) {
      if (notify) notifyInbound(db, { orgId, type: "SUGGESTED_REPLY", title: `Réponse suggérée en attente (${ch.toLowerCase()})`, message: "L'IA propose une réponse — à approuver ou rejeter.", link, leadId: conversation.lead_id || null });
      return { mode: "HYBRID", auto_replied: false, suggested_id: result.suggested.id, suggested: result.suggested, conversation_id: conversation.id, visitor_ack: ch === "WEBCHAT" ? ACK.HYBRID : null, metadata: result.metadata };
    }
    // Moteur bloqué (quota/rate limit/indisponibilité) : aucune suggestion
    if (notify) notifyInbound(db, { orgId, type: "AUTO_REPLY_BLOCKED", title: `Suggestion IA non générée (${ch.toLowerCase()})`, message: String(result.metadata?.error || "moteur bloqué"), link, leadId: conversation.lead_id || null });
    return { mode: "HYBRID", auto_replied: false, gate_reasons: [String(result.metadata?.error || "moteur bloqué")], conversation_id: conversation.id, visitor_ack: ch === "WEBCHAT" ? ACK.HUMAN : null, metadata: result.metadata };
  }

  /* ---------- AI : envoi de la réponse ---------- */
  const blocked = result.metadata?.blocked || result.metadata?.error;
  if (result.reply && !blocked) {
    if (ch === "WEBCHAT") {
      // La réponse est déjà dans la conversation (moteur) — rien à envoyer.
      db.prepare("UPDATE conversations SET unread_count = 0, last_message_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), conversation.id);
      return { mode: "AI", auto_replied: true, conversation_id: conversation.id, reply: result.reply, status: db.prepare("SELECT status FROM conversations WHERE id = ?").get(conversation.id)?.status || "ACTIVE", metadata: result.metadata };
    }
    const send = await sendExternal(result.reply);
    if (send.status === "sent") {
      db.prepare("UPDATE conversations SET unread_count = 0, last_message_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), conversation.id);
      return { mode: "AI", auto_replied: true, conversation_id: conversation.id, reply: result.reply, send, metadata: result.metadata };
    }
    // Échec honnête : l'équipe est prévenue, aucun faux succès
    logAudit(db, { organizationId: orgId, userId, action: "AUTO_REPLY_SEND_FAILED", resourceType: "conversation", resourceId: conversation.id, metadata: { channel: ch, error: String(send.error || "").slice(0, 200) } });
    if (notify) notifyInbound(db, { orgId, type: "SEND_FAILED", title: `Échec d'envoi de l'auto-réponse (${ch.toLowerCase()})`, message: String(send.error || "erreur inconnue"), link, leadId: conversation.lead_id || null });
    return { mode: "AI", auto_replied: false, send_failed: send.error, conversation_id: conversation.id, metadata: result.metadata };
  }
  // Moteur bloqué (quota, rate limit, indisponibilité) : réponse de repli au visiteur
  // (webchat uniquement) ; pas d'envoi externe avec un message de quota.
  if (notify) notifyInbound(db, { orgId, type: "AUTO_REPLY_BLOCKED", title: `Auto-réponse IA bloquée (${ch.toLowerCase()})`, message: String(result.metadata?.blocked || result.metadata?.error || "moteur"), link, leadId: conversation.lead_id || null });
  return { mode: "AI", auto_replied: false, blocked: String(result.metadata?.blocked || result.metadata?.error || "moteur"), conversation_id: conversation.id, visitor_ack: ch === "WEBCHAT" ? (result.reply || ACK.HUMAN) : null, metadata: result.metadata };
}


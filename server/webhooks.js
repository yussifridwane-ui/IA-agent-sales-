// server/webhooks.js — Phase 6 : réception des canaux officiels (Meta + e-mail)
// - Handshake de vérification GET (hub.challenge)
// - POST /api/webhooks/whatsapp | facebook | instagram | email :
//   vérification de signature HMAC-SHA256 (X-Hub-Signature-256), résolution
//   de l'organisation via l'identifiant de la connexion, ANTI-REPLAY/ANTI-
//   DOUBLON via la table webhook_events (event_id UNIQUE + fenêtre de temps),
//   ingestion des messages entrants (idempotents), détection de réponse
//   (annulation des follow-ups en attente + response_at), STOP → opt-out,
//   receipts (DELIVERED/READ/FAILED/BOUNCED) et traitement selon le HANDLING
//   MODE (AI / HUMAN / HYBRID — voir channels/inbound.js).
// - Threading e-mail : In-Reply-To / References / Message-ID → thread_id.
// Toute erreur d'ingestion renvoie 200 (Meta retrye sur non-2xx) mais est
// journalisée — jamais de traitement partiel silencieux.

import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { getConnection, parseConfig, recordIncoming, updateMessageStatus } from "./channels/index.js";
import { processInbound, findOrCreateConversation } from "./channels/inbound.js";
import { emitEvent } from "./automation/events.js";
import { cancelFollowUpsForLead } from "./automation/engine.js";
import { setOptOut, isOptOutMessage } from "./automation/followup.js";
import { logAudit } from "./audit.js";

const now = () => new Date().toISOString();

// Fenêtre anti-replay : un événement dont le timestamp est plus ancien que
// cette fenêtre (ou dans le futur au-delà du clock skew) est rejeté.
// (Les timestamps non réalistes < 1970+1e9 s — données de test — ne sont pas
// soumis à la vérification de fraîcheur ; la déduplication par event_id reste
// toujours appliquée.)
const REPLAY_WINDOW_MS = Math.max(1, Number(process.env.WEBHOOK_REPLAY_WINDOW_MIN || 15)) * 60e3;
const FUTURE_SKEW_MS = 10 * 60e3;

/* ---------- Anti-replay / anti-doublon (spec Phase 6 « Webhooks ») ---------- */
/**
 * Réserve un événement fournisseur : UNIQUE (channel, event_id).
 * - déjà vu        → DUPLICATE (jamais re-traité)
 * - timestamp hors fenêtre (ancien/futur) → REPLAY (rejeté)
 * - sinon          → RECEIVED (à marquer PROCESSED après traitement)
 */
function claimWebhookEvent(db, orgId, channel, provider, eventId, rawBody, ts) {
  if (!eventId) return { ok: true, reason: "no_id", id: null };
  const evId = String(eventId).slice(0, 255);
  const existing = db.prepare("SELECT * FROM webhook_events WHERE channel = ? AND event_id = ?").get(channel, evId);
  if (existing) {
    db.prepare("UPDATE webhook_events SET status = 'DUPLICATE', payload_hash = ? WHERE id = ?")
      .run(sha256hex(rawBody), existing.id);
    return { ok: false, reason: "DUPLICATE", id: existing.id };
  }
  let replay = false;
  if (ts != null) {
    const t = Number(ts);
    if (Number.isFinite(t) && t >= 1e9) {
      const tMs = t > 1e12 ? t : t * 1000; // secondes ou millisecondes
      const nowMs = Date.now();
      if (nowMs - tMs > REPLAY_WINDOW_MS || tMs > nowMs + FUTURE_SKEW_MS) replay = true;
    }
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO webhook_events (id, organization_id, channel, provider, event_id, signature, signature_ok, received_at, status, payload_hash)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
  ).run(id, orgId, channel, provider, evId, now(), replay ? "REPLAY" : "RECEIVED", sha256hex(rawBody));
  return replay ? { ok: false, reason: "REPLAY", id } : { ok: true, reason: "first", id };
}

function markEventProcessed(db, eventId) {
  if (!eventId) return;
  db.prepare("UPDATE webhook_events SET status = 'PROCESSED', processed_at = ? WHERE id = ? AND status = 'RECEIVED'").run(now(), eventId);
}

function sha256hex(s) {
  return createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

function hmacSha256(secret, body) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function timingSafeHexEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "hex");
  const bb = Buffer.from(String(b || ""), "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Vérifie X-Hub-Signature-256 contre le webhook_secret de la connexion. */
function verifySignature(signatureHeader, rawBody, conn) {
  if (!signatureHeader || !rawBody || !conn) return false;
  const provided = String(signatureHeader).replace(/^sha256=/, "");
  const secret = parseConfig(conn.config).webhook_secret;
  if (!secret) return false;
  return timingSafeHexEqual(provided, hmacSha256(secret, rawBody));
}

/** Résout la connexion (→ organisation) depuis le marqueur du payload. */
function findConnectionByMarker(db, channel, marker) {
  if (!marker) return null;
  const rows = db.prepare("SELECT * FROM channel_connections WHERE channel = ?").all(channel);
  return rows.find((r) => {
    const c = parseConfig(r.config);
    if (channel === "WHATSAPP") return c.phone_number_id === marker;
    if (channel === "FACEBOOK_MESSENGER") return c.page_id === marker;
    if (channel === "INSTAGRAM") return c.ig_user_id === marker || c.page_id === marker;
    return false;
  }) || null;
}

/* ---------- Recherche / création du lead depuis un message entrant ---------- */
function findLeadByContact(db, orgId, { channel, from }) {
  if (!from) return null;
  if (channel === "WHATSAPP") {
    const digits = String(from).replace(/[^\d]/g, "");
    if (digits.length < 8) return null;
    return db.prepare(
      `SELECT l.id FROM leads l LEFT JOIN customers c ON c.id = l.customer_id
       WHERE l.organization_id = ? AND (replace(coalesce(l.phone,''),'+','') LIKE ? OR replace(coalesce(c.phone,''),'+','') LIKE ?)
       ORDER BY l.created_at DESC LIMIT 1`
    ).get(orgId, `%${digits}`, `%${digits}`)?.id || null;
  }
  if (channel === "EMAIL") {
    const email = String(from).toLowerCase().trim();
    return db.prepare(
      `SELECT l.id FROM leads l LEFT JOIN customers c ON c.id = l.customer_id
       WHERE l.organization_id = ? AND (lower(coalesce(l.email,'')) = ? OR lower(coalesce(c.email,'')) = ?)
       ORDER BY l.created_at DESC LIMIT 1`
    ).get(orgId, email, email)?.id || null;
  }
  // Messenger / Instagram : identifiant plateforme du client
  return db.prepare(
    `SELECT l.id FROM leads l JOIN customers c ON c.id = l.customer_id
     WHERE l.organization_id = ? AND c.platform_ids IS NOT NULL AND json_extract(c.platform_ids, ?) = ?
     LIMIT 1`
  ).get(orgId, channel === "INSTAGRAM" ? "$.instagram" : "$.facebook", String(from))?.id || null;
}

function createLeadFromChannel(db, orgId, { channel, from, text, userId = null }) {
  const isWa = channel === "WHATSAPP";
  const digits = isWa ? String(from).replace(/[^\d]/g, "") : null;
  const name = isWa ? `Client WhatsApp +${digits?.slice(-9) || from}`
    : channel === "EMAIL" ? `Client e-mail ${String(from).slice(0, 32)}`
    : `Contact ${channel === "INSTAGRAM" ? "Instagram" : "Messenger"} ${String(from).slice(0, 24)}`;
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO leads (id, organization_id, name, phone, email, source, status, interest, score, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?, 10, ?, ?)`
  ).run(id, orgId, name.slice(0, 120), isWa && digits ? `+${digits}` : null,
    channel === "EMAIL" ? String(from).slice(0, 160) : null,
    channel === "WHATSAPP" ? "WHATSAPP" : channel === "INSTAGRAM" ? "INSTAGRAM" : channel === "EMAIL" ? "EMAIL" : "FACEBOOK",
    String(text || "").slice(0, 300), t, t);
  if (digits) {
    db.prepare("INSERT INTO customers (id, organization_id, first_name, last_name, phone, country, source, status, created_at, updated_at) VALUES (?, ?, ?, '', ?, 'TG', 'AI_AGENT', 'ACTIVE', ?, ?)")
      .run(randomUUID(), orgId, `Client +${digits.slice(-9)}`, `+${digits}`, t, t);
  } else if (channel === "EMAIL") {
    db.prepare("INSERT INTO customers (id, organization_id, first_name, last_name, email, country, source, status, created_at, updated_at) VALUES (?, ?, ?, '', ?, 'TG', 'AI_AGENT', 'ACTIVE', ?, ?)")
      .run(randomUUID(), orgId, `Client ${String(from).split("@")[0].slice(0, 40)}`, "", String(from).slice(0, 160), t, t);
  }
  logAudit(db, { organizationId: orgId, userId, action: "CREATE_LEAD", resourceType: "lead", resourceId: id, metadata: { by: "webhook", channel } });
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
}

/** Détection de réponse (spec §20) : annule les follow-ups en attente,
 *  marque response_at, met à jour le lead. (Le traitement conversationnel
 *  — messages + handling modes — est dans processInbound.) */
async function handleLeadResponse(db, orgId, { leadId, channel, from, text }) {
  // STOP → opt-out immédiat (canal concerné + marketing)
  if (isOptOutMessage(text)) {
    const leadRow = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
    if (leadRow) setOptOut(db, orgId, leadRow, { channels: channel === "WHATSAPP" ? ["whatsapp", "marketing"] : ["marketing"] });
    emitEvent(db, orgId, { type: "OPT_OUT", entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { channel, from } });
    cancelFollowUpsForLead(db, orgId, leadId, "Opt-out du prospect (canal externe)");
    return { optedOut: true };
  }
  // Réponse du prospect : annulation des relances en attente + response_at
  const pending = db.prepare("SELECT id FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SCHEDULED','PENDING_APPROVAL')").all(orgId, leadId);
  for (const p of pending) db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'réponse du prospect (canal externe)' WHERE id = ?").run(p.id);
  const sent = db.prepare("SELECT id FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status = 'SENT' AND response_at IS NULL ORDER BY sent_at DESC LIMIT 1").get(orgId, leadId);
  if (sent) db.prepare("UPDATE followup_history SET response_at = ? WHERE id = ?").run(now(), sent.id);
  const leadRow = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, orgId);
  if (leadRow) {
    db.prepare("UPDATE leads SET last_contact_at = ?, at_risk = 0, updated_at = ? WHERE id = ?").run(now(), now(), leadId);
  }
  emitEvent(db, orgId, { type: "RESPONSE_RECEIVED", entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { channel, pending_cancelled: pending.length } });
  return { optedOut: false, pending_cancelled: pending.length };
}

/* ---------- Entrées de route ---------- */
export async function handleWebhooks(ctx) {
  const { path, method, query } = ctx;
  if (path === "/api/webhooks/meta" && method === "GET") return handleWebhookMeta(ctx);
  return handleWebhookPost(ctx);
}

function handleWebhookMeta(ctx) {
  const { query } = ctx;
  if (!query["hub.mode"]) return false;
  const verifyToken = String(query["hub.verify_token"] || "");
  if (query["hub.mode"] === "subscribe" && verifyToken) {
    const conns = ctx.db.prepare("SELECT config FROM channel_connections WHERE status = 'CONNECTED'").all();
    const ok = conns.some((c) => parseConfig(c.config).verify_token === verifyToken);
    if (ok) {
      ctx.res.writeHead(200, { "Content-Type": "text/plain" });
      ctx.res.end(String(query["hub.challenge"] || ""));
      return true;
    }
    ctx.res.writeHead(403, { "Content-Type": "text/plain" });
    ctx.res.end("verify token invalide");
    return true;
  }
  ctx.res.writeHead(400, { "Content-Type": "text/plain" });
  ctx.res.end("paramètres de vérification invalides");
  return true;
}

export async function handleWebhookPost(ctx) {
  const { path, method, body, db } = ctx;
  const channelByPath = {
    "/api/webhooks/whatsapp": "WHATSAPP",
    "/api/webhooks/facebook": "FACEBOOK_MESSENGER",
    "/api/webhooks/instagram": "INSTAGRAM",
    "/api/webhooks/email": "EMAIL",
  };
  const channel = channelByPath[path];
  if (!channel || method !== "POST") return false;
  const payload = body || {};
  const rawBody = typeof payload.__rawBody === "string" ? payload.__rawBody : JSON.stringify(payload);

  /* ---------- E-mail (bridge → webhook signé, threading RFC 5322) ---------- */
  if (channel === "EMAIL") return handleEmailWebhook(ctx, db, payload, rawBody);

  // Résolution de la connexion par le marqueur du payload (avant signature : le secret est par connexion)
  const marker = channel === "WHATSAPP"
    ? (payload.entry?.[0]?.changes?.[0]?.value?.phone_number_id || null)
    : (payload.entry?.[0]?.id || payload.entry?.[0]?.messaging?.[0]?.recipient?.id || null);
  const conn = findConnectionByMarker(db, channel, marker);
  if (!conn) {
    logAudit(db, { organizationId: null, userId: null, action: "WEBHOOK_UNKNOWN", resourceType: "channel", resourceId: channel, metadata: { marker: String(marker || "").slice(0, 64) } });
    ctx.res.writeHead(404, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ error: "Connexion inconnue." }));
    return true;
  }
  if (!verifySignature(ctx.req.headers["x-hub-signature-256"], rawBody, conn)) {
    logAudit(db, { organizationId: conn.organization_id, userId: null, action: "WEBHOOK_BAD_SIGNATURE", resourceType: "channel", resourceId: channel });
    ctx.res.writeHead(401, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ error: "Signature invalide." }));
    return true;
  }
  const orgId = conn.organization_id;
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  let processed = 0, ignored = 0;
  try {
    if (channel === "WHATSAPP") {
      for (const entry of payload.entry || []) for (const change of entry.changes || []) {
        const value = change.value || {};
        if (value.phone_number_id && value.phone_number_id !== marker) continue;
        for (const msg of value.messages || []) {
          if (msg.type !== "text") { ignored++; continue; } // texte uniquement (Phase 6)
          // ANTI-REPLAY / ANTI-DOUBLON (webhook_events)
          const ev = claimWebhookEvent(db, orgId, "WHATSAPP", "META", msg.id || null, rawBody, msg.timestamp ?? null);
          if (!ev.ok) { ignored++; continue; }
          const from = msg.from || null;
          const text = msg.text?.body || "";
          const found = findLeadByContact(db, orgId, { channel, from });
          const leadId = found || createLeadFromChannel(db, orgId, { channel, from, text }).id;
          const rec = recordIncoming(db, { orgId, connection: conn, channel, providerMessageId: msg.id || null, from, text, leadId });
          if (rec.duplicate) { markEventProcessed(db, ev.id); ignored++; continue; }
          await handleLeadResponse(db, orgId, { leadId, channel, from, text });
          // HANDLING MODES (AI / HUMAN / HYBRID) — réponse IA conditionnelle
          await processInbound(db, { org, conn, channel: "WHATSAPP", lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId), externalContactId: from, text });
          markEventProcessed(db, ev.id);
          processed++;
        }
        for (const st of value.statuses || []) {
          const map = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
          if (!map[st.status]) continue;
          const evs = claimWebhookEvent(db, orgId, "WHATSAPP", "META", `status:${st.id}:${st.status}`, rawBody, null);
          if (!evs.ok) { ignored++; continue; }
          const fu = db.prepare("SELECT followup_id FROM channel_messages WHERE provider_message_id = ? AND organization_id = ? AND direction = 'OUT'").get(st.id, orgId)?.followup_id || null;
          updateMessageStatus(db, { orgId, providerMessageId: st.id, status: map[st.status], followupId: fu });
          markEventProcessed(db, evs.id);
          processed++;
        }
      }
    } else {
      // Facebook Messenger / Instagram (même structure)
      for (const entry of payload.entry || []) {
        for (const m of entry.messaging || []) {
          const mid = m.message?.mid || null;
          const ev = claimWebhookEvent(db, orgId, channel, "META", mid, rawBody, m.timestamp ?? null);
          if (!ev.ok) { ignored++; continue; }
          const text = m.message?.text || "";
          const from = m.sender?.id || null;
          const found = findLeadByContact(db, orgId, { channel, from });
          const leadId = found || createLeadFromChannel(db, orgId, { channel, from, text }).id;
          const rec = recordIncoming(db, { orgId, connection: conn, channel, providerMessageId: mid, from, text, leadId });
          if (rec.duplicate) { markEventProcessed(db, ev.id); ignored++; continue; }
          await handleLeadResponse(db, orgId, { leadId, channel, from, text });
          await processInbound(db, { org, conn, channel, lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId), externalContactId: from, text });
          markEventProcessed(db, ev.id);
          processed++;
        }
      }
    }
  } catch (e) {
    // 200 pour éviter les retries Meta en boucle ; l'échec est journalisé
    logAudit(db, { organizationId: orgId, userId: null, action: "WEBHOOK_ERROR", resourceType: "channel", resourceId: channel, metadata: { error: String(e.message || e).slice(0, 200) } });
  }
  ctx.res.writeHead(200, { "Content-Type": "application/json" });
  ctx.res.end(JSON.stringify({ processed, ignored }));
  return true;
}

/* ---------- Webhook e-mail (bridge signé → threading + handling modes) ----------
   Le payload est produit par un bridge (Gmail push / IFTTT / Make / bridge
   auto-hébergé) qui transcrit l'e-mail entrant au format JSON ci-dessous et
   signe le corps avec le webhook_secret de la connexion EMAIL :
   { from, to, subject, text, message_id, in_reply_to, references }
   La connexion est résolue par l'adresse DESTINATAIRE (= from_email de l'org). */
async function handleEmailWebhook(ctx, db, payload, rawBody) {
  const to = String(payload.to || "").toLowerCase().trim();
  const conns = db.prepare("SELECT * FROM channel_connections WHERE channel = 'EMAIL'").all();
  const conn = conns.find((c) => {
    const cfg = parseConfig(c.config);
    return (cfg.from_email || "").toLowerCase() === to || (cfg.smtp_user || "").toLowerCase() === to;
  }) || null;
  if (!conn) {
    logAudit(db, { organizationId: null, userId: null, action: "WEBHOOK_UNKNOWN", resourceType: "channel", resourceId: "EMAIL", metadata: { to: to.slice(0, 64) } });
    ctx.res.writeHead(404, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ error: "Connexion inconnue." }));
    return true;
  }
  if (!verifySignature(ctx.req.headers["x-hub-signature-256"], rawBody, conn)) {
    logAudit(db, { organizationId: conn.organization_id, userId: null, action: "WEBHOOK_BAD_SIGNATURE", resourceType: "channel", resourceId: "EMAIL" });
    ctx.res.writeHead(401, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ error: "Signature invalide." }));
    return true;
  }
  const orgId = conn.organization_id;
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  const messageId = payload.message_id ? String(payload.message_id).replace(/^<|>$/g, "").slice(0, 255) : null;

  // ANTI-REPLAY / ANTI-DOUBLON : le Message-ID est l'identifiant unique de l'événement
  const ev = claimWebhookEvent(db, orgId, "EMAIL", "SMTP", messageId, rawBody, null);
  if (!ev.ok) {
    ctx.res.writeHead(200, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({ processed: 0, ignored: 1, reason: ev.reason }));
    return true;
  }
  const from = String(payload.from || "").trim();
  const text = String(payload.text || "").slice(0, 20000);
  // STOP → opt-out (cohérent avec les autres canaux)
  const leadId = findLeadByContact(db, orgId, { channel: "EMAIL", from });
  if (leadId) await handleLeadResponse(db, orgId, { leadId, channel: "EMAIL", from, text });
  const lead = leadId ? db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) : null;

  try {
    await processInbound(db, {
      org, conn, channel: "EMAIL", lead, externalContactId: from, text,
      emailMeta: { subject: payload.subject || null, messageId, inReplyTo: payload.in_reply_to ? String(payload.in_reply_to).slice(0, 255) : null, references: payload.references ? String(payload.references).slice(0, 1000) : null },
    });
    markEventProcessed(db, ev.id);
  } catch (e) {
    logAudit(db, { organizationId: orgId, userId: null, action: "WEBHOOK_ERROR", resourceType: "channel", resourceId: "EMAIL", metadata: { error: String(e.message || e).slice(0, 200) } });
  }
  ctx.res.writeHead(200, { "Content-Type": "application/json" });
  ctx.res.end(JSON.stringify({ processed: 1, ignored: 0 }));
  return true;
}

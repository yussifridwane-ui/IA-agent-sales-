// server/channels/index.js — Phase 6 : routeur des canaux officiels
// Une seule entrée pour l'Automation Engine : sendOnChannel(). Résout la
// connexion de l'organisation, l'adresse du contact, envoie via le client
// officiel (retry limité, jamais de faux succès) et journalise channel_messages.

import { randomUUID } from "node:crypto";
import { sendWhatsApp, verifyWhatsApp, sendWhatsAppTemplate } from "./whatsapp.js";
import { sendMessenger, verifyMessenger } from "./messenger.js";
import { sendInstagram, verifyInstagram } from "./instagram.js";
import { sendEmail, verifyEmail } from "./email.js";
import { sendSMS, verifySMS } from "./sms.js";
import { encryptConfig, parseConfig as parseConfigCrypto, maskConfig as maskConfigCrypto, SECRET_FIELDS } from "./crypto.js";

const now = () => new Date().toISOString();

// Rétro-compatibilité : parseConfig/maskConfig gèrent le chiffrement au repos.
export const parseConfig = parseConfigCrypto;
export const maskConfig = maskConfigCrypto;

export const CHANNEL_DEFS = {
  WHATSAPP: {
    label: "WhatsApp Business",
    provider: "META",
    account_field: "phone_number_id",
    fields: ["phone_number_id", "access_token", "verify_token", "webhook_secret"],
    verify: verifyWhatsApp,
    send: (cfg, p) => sendWhatsApp(cfg, p),
    sendTemplate: (cfg, p) => sendWhatsAppTemplate(cfg, p),
  },
  FACEBOOK_MESSENGER: {
    label: "Facebook Messenger",
    provider: "META",
    account_field: "page_id",
    fields: ["page_id", "access_token", "verify_token", "webhook_secret"],
    verify: verifyMessenger,
    send: (cfg, p) => sendMessenger(cfg, p),
  },
  INSTAGRAM: {
    label: "Instagram Direct",
    provider: "META",
    account_field: "ig_user_id",
    fields: ["ig_user_id", "access_token", "verify_token", "webhook_secret"],
    verify: verifyInstagram,
    send: (cfg, p) => sendInstagram(cfg, p),
  },
  EMAIL: {
    label: "E-mail (SMTP)",
    provider: "SMTP",
    account_field: "from_email",
    // webhook_secret : signe les e-mails entrants du bridge (spec Phase 6).
    fields: ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_pass", "from_email", "from_name", "webhook_secret"],
    verify: verifyEmail,
    send: (cfg, p) => sendEmail(cfg, p),
  },
  SMS: {
    label: "SMS",
    provider: "TWILIO",
    account_field: "from_number",
    fields: ["provider", "account_sid", "auth_token", "from_number"],
    verify: verifySMS,
    send: (cfg, p) => sendSMS(cfg, p),
  },
  WEBCHAT: {
    label: "Webchat (widget intégré)",
    provider: "BUILTIN",
    account_field: null,
    fields: [],
    verify: async () => ({ ok: true, error: null }),
    send: async (cfg, p) => ({ status: "sent", provider_message_id: null, error: null }),
  },
};

/** Statut d'une connexion : NOT_CONFIGURED | CONFIGURATION_REQUIRED | CONNECTED | ERROR. */
export function connectionStatus(conn) {
  if (!conn) return "NOT_CONFIGURED";
  if (conn.status === "CONNECTED") return "CONNECTED";
  if (conn.status === "ERROR") return "ERROR";
  return conn.config ? "CONFIGURATION_REQUIRED" : "NOT_CONFIGURED";
}

/** Statut de livraison d'un message côté fournisseur (jamais inventé). */
export function getMessageStatus(db, orgId, providerMessageId) {
  if (!providerMessageId) return null;
  const m = db.prepare("SELECT status, updated_at FROM channel_messages WHERE organization_id = ? AND provider_message_id = ? ORDER BY created_at DESC LIMIT 1").get(orgId, providerMessageId);
  return m || null;
}

export function getConnection(db, orgId, channel) {
  return db.prepare("SELECT * FROM channel_connections WHERE organization_id = ? AND channel = ?").get(orgId, channel) || null;
}

export function allConnections(db, orgId) {
  return db.prepare("SELECT * FROM channel_connections WHERE organization_id = ? ORDER BY channel").all(orgId);
}

/**
 * Crée/met à jour la connexion d'un canal. Les secrets vides (ou "••••")
 * conservent la valeur existante — jamais écrasée par le masquage UI.
 * Vérifie la connexion (API officielle) et met à jour le statut.
 */
export async function upsertConnection(db, orgId, channel, body) {
  const def = CHANNEL_DEFS[channel];
  if (!def) return { error: "Canal inconnu." };
  const existing = getConnection(db, orgId, channel);
  const prev = parseConfig(existing?.config);
  const config = {};
  for (const f of def.fields) {
    let v = body[f];
    if (v === undefined) v = prev[f] ?? null;
    if (v === "••••" || v === "") v = prev[f] ?? null; // le masque ne doit pas écraser
    if (f === "smtp_port" && v !== null && v !== undefined) v = Number(v) || null;
    if (f === "smtp_secure") v = v === true || v === "true" || v === 1;
    config[f] = v == null ? null : String(v);
  }
  // Secret de signature des webhooks — généré automatiquement et retourné UNE
  // SEULE FOIS à la création (SMS : la signature Twilio utilise l'auth_token).
  if (config.webhook_secret == null && channel !== "SMS") {
    config.webhook_secret = randomUUID();
  }
  const id = existing?.id || randomUUID();
  const displayName = body.display_name ? String(body.display_name).slice(0, 80) : existing?.display_name || def.label;
  const accountIdentifier = def.account_field ? (config[def.account_field] || null) : null;
  // Secrets chiffrés au repos (AES-256-GCM) — jamais stockés/retournés en clair.
  db.prepare(
    `INSERT INTO channel_connections (id, organization_id, channel, status, config, display_name, provider, account_identifier, last_error, last_checked_at, connected_at, created_at, updated_at)
     VALUES (?, ?, ?, 'DISCONNECTED', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(organization_id, channel) DO UPDATE SET config = excluded.config, display_name = excluded.display_name, provider = excluded.provider, account_identifier = excluded.account_identifier, updated_at = excluded.updated_at`
  ).run(id, orgId, channel, encryptConfig(config), displayName, def.provider || null, accountIdentifier, existing?.created_at || now(), now());
  // Vérification auprès de l'API officielle (mock en test)
  let v;
  try { v = await def.verify(config); } catch (e) { v = { ok: false, error: String(e.message || e) }; }
  const hasConfig = Object.values(config).some((v) => v != null && v !== "");
  // NOT_CONFIGURED (aucune config) vs ERROR (config présente mais vérification échouée)
  const status = v.ok ? "CONNECTED" : (hasConfig ? "ERROR" : "DISCONNECTED");
  db.prepare("UPDATE channel_connections SET status = ?, last_error = ?, last_checked_at = ?, connected_at = ? WHERE id = ?")
    .run(status, v.ok ? null : String(v.error).slice(0, 300), now(), v.ok ? (existing?.connected_at && existing.status === "CONNECTED" ? existing.connected_at : now()) : null, id);
  // Le secret n'est retourné QUE lors de sa génération (nouvelle connexion, ou
  // ré-connexion après déconnexion) — jamais lors d'une simple mise à jour.
  const isNewSecret = config.webhook_secret && (!existing || !existing.config || existing.status === "DISCONNECTED" || !parseConfig(existing.config).webhook_secret);
  return {
    id, channel, status, config: maskConfig(config), display_name: displayName,
    webhook_secret_new: isNewSecret ? config.webhook_secret : undefined,
    // error = erreur de validation (→ 400) ; verify_error = échec de vérification (→ 200 + status ERROR)
    error: null,
    verify_error: v.ok ? null : String(v.error).slice(0, 300),
    last_error: v.ok ? null : String(v.error).slice(0, 300),
  };
}

export function disconnectConnection(db, orgId, channel) {
  const existing = getConnection(db, orgId, channel);
  if (!existing) return false;
  db.prepare("UPDATE channel_connections SET status = 'DISCONNECTED', config = NULL, last_error = NULL, connected_at = NULL, updated_at = ? WHERE id = ?").run(now(), existing.id);
  return true;
}

/* ---------- Adresse du contact selon le canal ---------- */
function contactForChannel(db, orgId, lead, channel) {
  const customer = lead.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(lead.customer_id, orgId) : null;
  const platform = customer ? parseConfig(customer.platform_ids) : {};
  switch (channel) {
    case "WHATSAPP": {
      const phone = String(lead.phone || customer?.phone || "").replace(/[^\d]/g, "");
      return phone.length >= 8 ? phone : null;
    }
    case "EMAIL":
      return lead.email || customer?.email || null;
    case "FACEBOOK_MESSENGER":
      return platform.facebook || null;
    case "INSTAGRAM":
      return platform.instagram || null;
    default:
      return null;
  }
}

/**
 * Meilleur canal pour un lead (routage) : canal préféré déclaré, sinon le
 * premier canal connectable d'après les coordonnées du contact.
 */
export function bestChannelForLead(db, orgId, lead) {
  const pref = String(lead.preferred_channel || "").toUpperCase();
  const order = pref && CHANNEL_DEFS[pref] ? [pref, "WHATSAPP", "EMAIL", "FACEBOOK_MESSENGER", "INSTAGRAM", "WEBCHAT"] : ["WHATSAPP", "EMAIL", "FACEBOOK_MESSENGER", "INSTAGRAM", "WEBCHAT"];
  for (const c of order) {
    if (c === "WEBCHAT") {
      const conv = db.prepare("SELECT 1 n FROM conversations WHERE lead_id = ? AND organization_id = ? LIMIT 1").get(lead.id, orgId);
      if (conv) return c;
      continue;
    }
    if (getConnection(db, orgId, c)?.status !== "CONNECTED") continue;
    if (contactForChannel(db, orgId, lead, c)) return c;
  }
  return null;
}

/* ---------- Envoi unifié (entrée de l'Automation Engine) ---------- */
/**
 * Envoie un message sur un canal officiel. Renvoie :
 *  { status: "sent" | "failed" | "skipped", provider_message_id?, error? }
 * - Canal non connecté / adresse manquante → failed honnête (jamais simulé)
 * - Retry limité : 1 tentative supplémentaire sur échec transitoire
 */
export async function sendOnChannel(db, { orgId, channel, lead, to = null, subject = null, text, followup_id = null, connection_id = null, emailHeaders = null }) {
  const ch = String(channel || "WEBCHAT").toUpperCase();
  const msgId = randomUUID();
  const logRow = (status, { providerMessageId = null, error = null, toAddress = null, fromAddress = null } = {}) => {
    db.prepare(
      `INSERT INTO channel_messages (id, organization_id, connection_id, lead_id, followup_id, channel, direction, to_address, from_address, content, status, provider_message_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OUT', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(msgId, orgId, connection_id, lead?.id || null, followup_id, ch, toAddress, null, String(text || "").slice(0, 4000), status, providerMessageId, error, now(), now());
  };
  if (ch === "WEBCHAT") {
    // Canal intégré : insertion réelle dans la conversation du lead
    const conv = db.prepare("SELECT id FROM conversations WHERE lead_id = ? AND organization_id = ? ORDER BY updated_at DESC LIMIT 1").get(lead?.id || null, orgId);
    if (!conv) {
      logRow("FAILED", { error: "Aucune conversation active pour ce lead." });
      return { status: "failed", error: "Aucune conversation active pour ce lead.", channel_message_id: msgId };
    }
    const convMsgId = randomUUID();
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, metadata, created_at) VALUES (?, ?, 'ASSISTANT', ?, ?, ?)")
      .run(convMsgId, conv.id, String(text || "").slice(0, 4000), JSON.stringify({ source: "followup", channel: "WEBCHAT", subject }), now());
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conv.id);
    logRow("SENT", { providerMessageId: convMsgId });
    return { status: "sent", provider_message_id: convMsgId, channel_message_id: msgId };
  }
  const conn = getConnection(db, orgId, ch);
  if (!conn || conn.status !== "CONNECTED") {
    logRow("FAILED", { error: "Canal non configuré." });
    return { status: "failed", error: "Canal non configuré.", channel_message_id: msgId };
  }
  const config = parseConfig(conn.config);
  const toAddress = to || (lead ? contactForChannel(db, orgId, lead, ch) : null);
  if (!toAddress) {
    const missing = ch === "EMAIL" ? "e-mail" : ch === "WHATSAPP" ? "numéro de téléphone" : "identifiant plateforme";
    logRow("FAILED", { error: `Adresse ${missing} manquante pour ce contact.` });
    return { status: "failed", error: `Adresse ${missing} manquante pour ce contact.`, channel_message_id: msgId };
  }
  const def = CHANNEL_DEFS[ch];
  const attempt = async () => def.send(config, { to: toAddress, text, subject, in_reply_to: emailHeaders?.in_reply_to || null, references: emailHeaders?.references || null });
  let r = await attempt();
  if (r.status === "failed" && !/non configuré|manquante|invalide/i.test(r.error || "")) {
    await new Promise((res) => setTimeout(res, 500)); // backoff court
    r = await attempt(); // retry unique (max 2 tentatives — jamais de boucle)
  }
  if (r.status === "sent") {
    logRow("SENT", { providerMessageId: r.provider_message_id, toAddress: toAddress });
    return { status: "sent", provider_message_id: r.provider_message_id, channel_message_id: msgId };
  }
  logRow("FAILED", { error: r.error, toAddress: toAddress });
  return { status: "failed", error: r.error, channel_message_id: msgId };
}

/* ---------- Réception (webhooks) ---------- */
/** Enregistre un message entrant (idempotent par provider_message_id). */
export function recordIncoming(db, { orgId, connection, channel, providerMessageId, from, text, leadId }) {
  if (providerMessageId) {
    const dup = db.prepare("SELECT id FROM channel_messages WHERE provider_message_id = ?").get(providerMessageId);
    if (dup) return { duplicate: true, id: dup.id };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO channel_messages (id, organization_id, connection_id, lead_id, channel, direction, to_address, from_address, content, status, provider_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'IN', NULL, ?, ?, 'SENT', ?, ?, ?)`
  ).run(id, orgId, connection?.id || null, leadId || null, channel, from, String(text || "").slice(0, 4000), providerMessageId || null, now(), now());
  return { duplicate: false, id };
}

/** Met à jour le statut d'un message (receipts : DELIVERED/READ/FAILED/BOUNCED). */
export function updateMessageStatus(db, { orgId, providerMessageId, status, followupId = null }) {
  const m = providerMessageId ? db.prepare("SELECT * FROM channel_messages WHERE provider_message_id = ? AND organization_id = ?").get(providerMessageId, orgId) : null;
  if (m) {
    db.prepare("UPDATE channel_messages SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), m.id);
  }
  if (followupId) {
    db.prepare("UPDATE followup_history SET status = ? WHERE id = ? AND status = 'SENT'").run(status, followupId);
  }
  return !!m;
}

// server/automation/channels.js — Phase 5 : abstraction des canaux de communication
// Principe (spec §13-14) : NE PAS simuler l'envoi. Chaque canal a un provider ;
// si aucun fournisseur n'est connecté → statut NOT_CONFIGURED et l'envoi échoue
// avec l'erreur « Canal non configuré. » (jamais de confirmation inventée).
//
// WEBCHAT est le seul canal RÉEL de la Phase 5 : il insère un message assistant
// dans la conversation du lead (comportement réel, visible, journalisé).

import { randomUUID } from "node:crypto";
import { isValidEmail } from "../security.js";

export const CHANNELS = ["EMAIL", "SMS", "WHATSAPP", "WEBCHAT", "INSTAGRAM", "FACEBOOK"];

/**
 * Provider EMAIL — fonctionne uniquement si un serveur SMTP est configuré
 * (env SMTP_HOST). Sinon : NOT_CONFIGURED, aucun envoi simulé.
 */
class EmailProvider {
  constructor() { this.channel = "EMAIL"; }
  configured() { return !!process.env.SMTP_HOST; }
  getStatus() { return this.configured() ? "READY" : "NOT_CONFIGURED"; }
  validate(to) { return isValidEmail(String(to || "")); }
  // Envoi réel via SMTP (non branché en Phase 5 — pas de fournisseur connecté par défaut)
  send() {
    return { status: "failed", error: "Canal non configuré." };
  }
}

/**
 * Provider WEBCHAT — canal réel intégré : le message est inséré dans la
 * conversation du lead (rôle ASSISTANT). Retourne le message créé ou un échec
 * explicite (jamais de faux succès).
 */
class WebchatProvider {
  constructor() { this.channel = "WEBCHAT"; }
  configured() { return true; } // canal intégré, toujours disponible
  getStatus() { return "READY"; }
  validate() { return true; }
  send(db, { leadId, subject, content, orgId, conversationId }) {
    const conv = conversationId
      ? db.prepare("SELECT id FROM conversations WHERE id = ? AND organization_id = ?").get(conversationId, orgId)
      : db.prepare("SELECT id FROM conversations WHERE lead_id = ? AND organization_id = ? ORDER BY updated_at DESC LIMIT 1").get(leadId, orgId);
    if (!conv) return { status: "failed", error: "Aucune conversation active pour ce lead." };
    const msgId = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, metadata, created_at) VALUES (?, ?, 'ASSISTANT', ?, ?, ?)")
      .run(msgId, conv.id, String(content || "").slice(0, 4000), JSON.stringify({ source: "followup", subject: subject || null }), now);
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conv.id);
    return { status: "sent", message_id: msgId };
  }
}

/** Provider générique non connecté (SMS, WhatsApp, Instagram, Facebook). */
class NotConfiguredProvider {
  constructor(channel) { this.channel = channel; }
  configured() { return false; }
  getStatus() { return "NOT_CONFIGURED"; }
  validate(to) { return String(to || "").length >= 3; }
  send() { return { status: "failed", error: "Canal non configuré." }; }
}

const PROVIDERS = new Map([
  ["EMAIL", new EmailProvider()],
  ["WEBCHAT", new WebchatProvider()],
  ["SMS", new NotConfiguredProvider("SMS")],
  ["WHATSAPP", new NotConfiguredProvider("WHATSAPP")],
  ["INSTAGRAM", new NotConfiguredProvider("INSTAGRAM")],
  ["FACEBOOK", new NotConfiguredProvider("FACEBOOK")],
]);

export function getProvider(channel) {
  const c = String(channel || "WEBCHAT").toUpperCase();
  return PROVIDERS.get(c) || null;
}

export function channelStatus() {
  return Object.fromEntries(CHANNELS.map((c) => {
    const p = PROVIDERS.get(c);
    return [c, p ? { status: p.getStatus(), configured: p.configured() } : { status: "UNKNOWN", configured: false }];
  }));
}

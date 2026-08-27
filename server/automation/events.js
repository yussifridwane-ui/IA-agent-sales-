// server/automation/events.js — Phase 5 : système d'événements commerciaux
// Chaque événement est journalisé (sales_events) puis traité par le Automation
// Engine (processEvent) de manière synchrone et non bloquante pour le flux appelant.

import { randomUUID } from "node:crypto";

export const EVENT_TYPES = [
  "LEAD_CREATED", "LEAD_UPDATED", "LEAD_BECAME_HOT", "LEAD_BECAME_COLD", "LEAD_SCORE_CHANGED",
  "PURCHASE_INTENT_DETECTED", "PRODUCT_VIEWED", "PRODUCT_INQUIRY", "PRICE_REQUESTED",
  "QUOTE_CREATED", "QUOTE_SENT", "QUOTE_VIEWED", "QUOTE_ACCEPTED", "QUOTE_REJECTED", "QUOTE_EXPIRED", "NO_RESPONSE",
  "ORDER_CREATED", "ORDER_PAID", "ORDER_COMPLETED",
  "PAYMENT_CONFIRMED", "PAYMENT_FAILED",
  "CONVERSATION_STARTED", "CONVERSATION_ENDED", "HUMAN_HANDOFF",
  "DEAL_CREATED", "DEAL_STAGE_CHANGED", "DEAL_AT_RISK", "DEAL_WON", "DEAL_LOST",
  "TASK_OVERDUE", "OPT_OUT", "RESPONSE_RECEIVED",
  "FOLLOWUP_SCHEDULED", "FOLLOWUP_SENT", "FOLLOWUP_FAILED", "FOLLOWUP_CANCELLED", "FOLLOWUP_REPLIED",
  "SEQUENCE_STARTED", "SEQUENCE_STOPPED", "SEQUENCE_COMPLETED",
  "CAMPAIGN_STARTED",
];

/** Journalise un événement et renvoie la ligne (jamais bloquant — wrap par l'appelant). */
export function emitEvent(db, orgId, { type, entity_type = null, entity_id = null, lead_id = null, conversation_id = null, payload = null }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Événement inconnu : ${type}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sales_events (id, organization_id, type, entity_type, entity_id, lead_id, conversation_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, type, entity_type, entity_id, lead_id, conversation_id, payload ? JSON.stringify(payload) : null, now);
  return db.prepare("SELECT * FROM sales_events WHERE id = ?").get(id);
}

/* ---------- Helpers de contexte (arrêt de séquences, détection de réponse) ---------- */

/** Dernier message client d'une conversation, depuis une date (ISO). */
export function lastUserMessageSince(db, conversationId, sinceIso) {
  if (!conversationId) return null;
  return db.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? AND role = 'USER' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).get(conversationId, sinceIso || "1970-01-01T00:00:00.000Z") || null;
}

/** Le lead a-t-il répondu (toutes ses conversations) depuis une date ? */
export function leadRepliedSince(db, orgId, leadId, sinceIso) {
  const row = db.prepare(
    `SELECT 1 AS n FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.organization_id = ? AND c.lead_id = ? AND m.role = 'USER' AND m.created_at > ?
     LIMIT 1`
  ).get(orgId, leadId, sinceIso || "1970-01-01T00:00:00.000Z");
  return !!row;
}

/** Dernière réponse client du lead (toutes conversations), null si aucune. */
export function lastLeadResponse(db, orgId, leadId) {
  return db.prepare(
    `SELECT m.created_at FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.organization_id = ? AND c.lead_id = ? AND m.role = 'USER'
     ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`
  ).get(orgId, leadId);
}

/** Une conversation humaine est-elle active pour ce lead (handoff en cours) ? */
export function humanTakeoverActive(db, orgId, leadId) {
  const row = db.prepare(
    "SELECT 1 AS n FROM conversations WHERE organization_id = ? AND lead_id = ? AND status = 'HANDOFF' LIMIT 1"
  ).get(orgId, leadId);
  return !!row;
}

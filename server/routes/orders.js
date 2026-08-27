// server/routes/orders.js — Phase 7 : Commandes (spec §22)
// Workflow : QUOTE ACCEPTED → ORDER (PENDING) → CONFIRMED → PAYMENT CONFIRMÉ
// (PAID) → PROCESSING → COMPLETED. + CANCELLED / REFUNDED.
// Règles d'or :
//  - une commande ne naît que d'un devis ACCEPTÉ (jamais de commande sans devis),
//  - une commande n'est PAID qu'après confirmation RÉELLE d'un paiement
//    (fournisseur — jamais simulé en production),
//  - COMPLETED avec deal lié → deal WON (événement DEAL_WON : les séquences et
//    follow-ups s'arrêtent automatiquement — Phase 5).
import { randomUUID } from "node:crypto";
import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import { emitEvent } from "../automation/events.js";
import { notifyUser, notifiableMembers } from "../automation/engine.js";

const nowIso = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const ORDER_STATUSES = ["PENDING", "CONFIRMED", "PAID", "PROCESSING", "COMPLETED", "CANCELLED", "REFUNDED"];
// Workflow : PENDING → CONFIRMED → (paiement confirmé) → PAID → PROCESSING → COMPLETED.
// PROCESSING n'est autorisé qu'après PAID (jamais de traitement d'une commande non payée).
const TRANSITIONS = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PAID", "CANCELLED"],
  PAID: ["PROCESSING", "REFUNDED"],
  PROCESSING: ["COMPLETED"],
  COMPLETED: ["REFUNDED"],
  REFUNDED: [],
  CANCELLED: [],
};

function fire(db, orgId, type, entityId, leadId = null, payload = null) {
  try { emitEvent(db, orgId, { type, entity_type: "order", entity_id: entityId, lead_id: leadId, payload }); } catch { /* non bloquant */ }
}

function orderNumber(db, orgId, year, offset = 0) {
  const n = db.prepare("SELECT COUNT(*) n FROM orders WHERE organization_id = ? AND number LIKE ?").get(orgId, `CMD-${year}-%`).n + 1 + offset;
  return `CMD-${year}-${String(n).padStart(4, "0")}`;
}

function getOrder(db, orgId, id) {
  return isUuid(id) ? db.prepare("SELECT * FROM orders WHERE id = ? AND organization_id = ?").get(id, orgId) : null;
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  const api = path.match(/^\/api\/orders(\/[0-9a-f-]+(\/[a-z-]+)?)?$/i);
  if (!api) return false;
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
  const orgId = ctx.org.id;

  /* Liste */
  if (method === "GET" && !api[1]) {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const status = String(ctx.query.status || "").toUpperCase();
    const rows = (status && ORDER_STATUSES.includes(status)
      ? db.prepare("SELECT * FROM orders WHERE organization_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200").all(orgId, status)
      : db.prepare("SELECT * FROM orders WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200").all(orgId));
    return ctx.sendJSON(200, { orders: rows, statuses: ORDER_STATUSES });
  }

  /* Création — uniquement depuis un devis ACCEPTÉ (idempotent par devis) */
  if (method === "POST" && !api[1]) {
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const quote = body.quote_id && isUuid(body.quote_id) ? db.prepare("SELECT * FROM quotes WHERE id = ? AND organization_id = ?").get(body.quote_id, orgId) : null;
    if (!quote) return ctx.sendJSON(400, { error: "Devis inconnu." });
    if (quote.status !== "ACCEPTED") return ctx.sendJSON(409, { error: `Une commande ne peut être créée que depuis un devis ACCEPTÉ (statut actuel : ${quote.status}).` });
    // Idempotence : une commande par devis
    const existing = db.prepare("SELECT * FROM orders WHERE quote_id = ?").get(quote.id);
    if (existing) return ctx.sendJSON(200, { order: existing, message: "Commande déjà créée pour ce devis (idempotence)." });
    const year = new Date().getFullYear();
    const id = randomUUID();
    let o = null;
    for (let attempt = 0; attempt < 4 && !o; attempt++) {
      try {
        db.prepare(
          `INSERT INTO orders (id, organization_id, number, quote_id, deal_id, customer_id, lead_id, status, currency, total, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`
        ).run(id, orgId, orderNumber(db, orgId, year, attempt), quote.id, quote.deal_id, quote.customer_id, quote.lead_id,
          quote.currency, quote.total, ctx.user.id, nowIso(), nowIso());
        o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
      } catch (e) {
        if (!String(e.message).includes("UNIQUE")) throw e;
      }
    }
    if (!o) return ctx.sendJSON(500, { error: "Génération du numéro de commande impossible." });
    fire(db, orgId, "ORDER_CREATED", o.id, o.lead_id, { order_id: o.id, number: o.number, quote_id: quote.id, total: o.total });
    logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "CREATE_ORDER", resourceType: "order", resourceId: o.id, metadata: { number: o.number, quote_id: quote.id } });
    for (const m of notifiableMembers(db, orgId)) {
      notifyUser(db, { orgId, userId: m.user_id, type: "ORDER_CREATED", title: `Commande ${o.number} créée`, message: `Total : ${o.total} ${o.currency || ""} — devis ${quote.number} accepté.`, link: `/dashboard/orders/${o.id}`, leadId: o.lead_id || null });
    }
    return ctx.sendJSON(201, { order: o });
  }

  const segs = api[1] ? api[1].split("/").filter(Boolean) : [];
  const idPart = segs[0] || null;
  if (!idPart) return false;
  const o = getOrder(db, orgId, idPart);
  if (!o) return ctx.sendJSON(404, { error: "Commande introuvable." });

  /* Détail */
  if (method === "GET" && segs.length === 1) {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const quote = o.quote_id ? db.prepare("SELECT * FROM quotes WHERE id = ? AND organization_id = ?").get(o.quote_id, orgId) : null;
    const items = quote ? db.prepare("SELECT * FROM quote_items WHERE quote_id = ? ORDER BY rowid").all(quote.id) : [];
    const customer = o.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(o.customer_id, orgId) : null;
    const deal = o.deal_id ? db.prepare("SELECT id, name, value, stage, probability FROM deals WHERE id = ? AND organization_id = ?").get(o.deal_id, orgId) : null;
    const payments = db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC").all(o.id);
    return ctx.sendJSON(200, { order: o, quote, items, customer, deal, payments });
  }

  /* Transition de statut */
  if (method === "POST") {
    const sub = segs[1] || null;
    const targets = { confirm: "CONFIRMED", processing: "PROCESSING", complete: "COMPLETED", cancel: "CANCELLED", refund: "REFUNDED" };
    if (!targets[sub]) return false;
    const target = targets[sub];
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    if (!TRANSITIONS[o.status].includes(target)) {
      return ctx.sendJSON(409, { error: `Transition ${o.status} → ${target} non autorisée (autorisées : ${TRANSITIONS[o.status].join(", ") || "aucune"}).` });
    }
    // PAID exige un paiement CONFIRMÉ (jamais de paiement simulé)
    if (target === "PAID") {
      const paid = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'CONFIRMED'").get(o.id);
      if (!paid) return ctx.sendJSON(409, { error: "Aucun paiement confirmé : la commande ne peut passer en PAID (jamais de paiement simulé)." });
    }
    // REFUNDED exige un paiement REFUNDED (ou pas de paiement confirmé)
    if (target === "REFUNDED") {
      const refunded = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'REFUNDED'").get(o.id);
      if (!refunded) return ctx.sendJSON(409, { error: "Aucun paiement remboursé : la commande ne peut passer en REFUNDED." });
    }
    const t = nowIso();
    if (target === "COMPLETED") {
      db.prepare("UPDATE orders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(target, t, t, o.id);
      fire(db, orgId, "ORDER_COMPLETED", o.id, o.lead_id, { order_id: o.id, number: o.number, total: o.total });
      // Deal lié → WON (les follow-ups/séquences s'arrêtent via DEAL_WON — Phase 5)
      const deal = o.deal_id ? db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(o.deal_id, orgId) : null;
      if (deal && !["WON", "LOST"].includes(deal.stage)) {
        db.prepare("UPDATE deals SET stage = 'WON', probability = 100, updated_at = ? WHERE id = ?").run(t, deal.id);
        fire(db, orgId, "DEAL_WON", deal.id, o.lead_id, { order_id: o.id, deal_id: deal.id });
      }
      if (o.lead_id) db.prepare("UPDATE leads SET last_contact_at = ?, updated_at = ? WHERE id = ? AND organization_id = ?").run(t, t, o.lead_id, orgId);
    } else if (target === "PAID") {
      db.prepare("UPDATE orders SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?").run(target, t, t, o.id);
      fire(db, orgId, "ORDER_PAID", o.id, o.lead_id, { order_id: o.id, number: o.number });
    } else {
      db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(target, t, o.id);
    }
    logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "ORDER_STATUS", resourceType: "order", resourceId: o.id, metadata: { from: o.status, to: target, number: o.number } });
    const fresh = db.prepare("SELECT * FROM orders WHERE id = ?").get(o.id);
    return ctx.sendJSON(200, { order: fresh, message: `Commande → ${target}.` });
  }
  return false;
}

/* ---------- Page /dashboard/orders ---------- */
export async function handlePage(ctx) {
  const { path } = ctx;
  if (path !== "/dashboard/orders") return false;
  if (!ctx.user || !ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403 — Permission insuffisante</h1>"); return true; }
  const db = ctx.db;
  const orgId = ctx.org.id;
  const { providerStatus } = await import("../payments/providers.js");
  const orders = db.prepare(
    `SELECT o.*, c.first_name || ' ' || c.last_name AS customer_name, q.number AS quote_number,
            (SELECT 1 FROM payments p WHERE p.order_id = o.id AND status = 'CONFIRMED') AS has_paid,
            (SELECT 1 FROM payments p2 WHERE p2.order_id = o.id AND status = 'PENDING') AS has_payment_pending
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN quotes q ON q.id = o.quote_id
     WHERE o.organization_id = ? ORDER BY o.created_at DESC LIMIT 100`
  ).all(orgId);
  const { ordersPage } = await import("../views/commerce.js");
  return ctx.sendHTML(200, ordersPage({ user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf, orders, providers: providerStatus(), currency: ctx.org.currency || "XOF" }));
}

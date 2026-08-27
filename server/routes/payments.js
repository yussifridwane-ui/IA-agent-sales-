// server/routes/payments.js — Phase 7 : Paiements (spec §23)
// - POST /api/payments { order_id, provider, method } → paiement PENDING
//   (ou 409 CONFIGURATION_REQUIRED honnête si le fournisseur n'est pas configuré)
// - Webhook /api/webhooks/payments/:provider — signature HMAC obligatoire,
//   vérification de la transaction auprès du fournisseur, puis CONFIRMED +
//   commande → PAID. JAMAIS de confirmation sans vérification réelle.
// - GET /api/payments/providers — statuts honnêtes (CONNECTED / CONFIGURATION_REQUIRED)
// - TEST provider : double de test UNIQUEMENT en APP_ENV=test (404 sinon).
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import { emitEvent } from "../automation/events.js";
import { notifyUser, notifiableMembers } from "../automation/engine.js";
import { PAYMENT_PROVIDERS, providerStatus, createIntent, verifyTransaction, webhookSecret } from "../payments/providers.js";
import { applyPaidInvoice } from "../billing.js";

const nowIso = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isTestEnv = () => process.env.APP_ENV === "test";

function fire(db, orgId, type, entityId, leadId = null, payload = null) {
  try { emitEvent(db, orgId, { type, entity_type: "payment", entity_id: entityId, lead_id: leadId, payload }); } catch { /* non bloquant */ }
}

/** Confirmation d'un paiement (webhook/test) :
 *  - paiement commande → commande PAID (Phase 7)
 *  - paiement facturation → facture PAID + plan appliqué (Phase 8)
 * Un paiement n'est CONFIRMED que par cette fonction (vérification fournisseur
 * préalable garantie par l'appelant). */
function confirmPayment(db, orgId, payment) {
  if (!payment || payment.status !== "PENDING") return payment;
  const t = nowIso();
  db.prepare("UPDATE payments SET status = 'CONFIRMED', confirmed_at = ?, updated_at = ? WHERE id = ?").run(t, t, payment.id);
  const order = payment.order_id ? db.prepare("SELECT * FROM orders WHERE id = ? AND organization_id = ?").get(payment.order_id, orgId) : null;
  if (order && ["PENDING", "CONFIRMED"].includes(order.status)) {
    db.prepare("UPDATE orders SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?").run(t, t, order.id);
    fire(db, orgId, "ORDER_PAID", order.id, order.lead_id, { order_id: order.id, number: order.number, payment_id: payment.id });
  }
  // Facturation SaaS : la facture passe PAID et le plan est appliqué (spec §8-9)
  let invoice = null;
  if (payment.invoice_id) {
    invoice = applyPaidInvoice(db, orgId, payment.invoice_id, payment.id);
  }
  fire(db, orgId, "PAYMENT_CONFIRMED", payment.id, order?.lead_id || null, { payment_id: payment.id, order_id: payment.order_id || null, invoice_id: payment.invoice_id || null, provider: payment.provider, amount: payment.amount });
  logAudit(db, { organizationId: orgId, userId: null, action: "PAYMENT_CONFIRMED", resourceType: "payment", resourceId: payment.id, metadata: { provider: payment.provider, tx: payment.provider_transaction_id, invoice: invoice?.number || null, by: "webhook" } });
  for (const m of notifiableMembers(db, orgId)) {
    notifyUser(db, { orgId, userId: m.user_id, type: "PAYMENT_CONFIRMED", title: `Paiement confirmé — ${order?.number || invoice?.number || ""}`, message: `${payment.amount} ${payment.currency || ""} (${payment.provider})${invoice ? ` · plan ${invoice.plan} activé` : ""}`, link: order ? `/dashboard/orders/${order.id}` : "/dashboard/billing", leadId: order?.lead_id || null });
  }
  return db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id);
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  const api = path.match(/^\/api\/payments(\/providers|\/[0-9a-f-]+(\/[a-z-]+)?)?$/i);
  if (!api) return false;

  /* Statuts des fournisseurs (public interne, honnête) */
  if (method === "GET" && api[1] === "/providers") {
    if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
    if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
    return ctx.sendJSON(200, { providers: providerStatus() });
  }

  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
  const orgId = ctx.org.id;

  /* Liste */
  if (method === "GET" && !api[1]) {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const rows = db.prepare(
      `SELECT p.*, o.number AS order_number FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.organization_id = ? ORDER BY p.created_at DESC LIMIT 200`
    ).all(orgId);
    return ctx.sendJSON(200, { payments: rows });
  }

  /* Création d'une intention de paiement */
  if (method === "POST" && !api[1]) {
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const order = body.order_id && isUuid(body.order_id) ? db.prepare("SELECT * FROM orders WHERE id = ? AND organization_id = ?").get(body.order_id, orgId) : null;
    if (!order) return ctx.sendJSON(400, { error: "Commande inconnue." });
    if (["COMPLETED", "CANCELLED", "REFUNDED"].includes(order.status)) {
      return ctx.sendJSON(409, { error: `Commande ${order.status} : plus de paiement possible.` });
    }
    const provider = String(body.provider || "").toUpperCase();
    if (provider === "TEST" && !isTestEnv()) return ctx.sendJSON(404, { error: "Non disponible hors mode test." });
    if (!PAYMENT_PROVIDERS[provider]) return ctx.sendJSON(400, { error: `Fournisseur inconnu : ${provider}` });
    const intent = await createIntent({ provider, order, method: body.method ? String(body.method).slice(0, 40) : null });
    if (intent.status === "CONFIGURATION_REQUIRED") {
      return ctx.sendJSON(409, {
        status: "CONFIGURATION_REQUIRED",
        provider,
        needs: intent.needs,
        message: `Fournisseur ${provider} non configuré : ${intent.needs.join(" + ")}. Aucun paiement n'est créé (jamais simulé).`,
      });
    }
    if (intent.status !== "PENDING") return ctx.sendJSON(502, { error: intent.error || "Création de l'intention de paiement impossible." });
    const id = randomUUID();
    const t = nowIso();
    db.prepare(
      `INSERT INTO payments (id, organization_id, order_id, provider, provider_transaction_id, method, amount, currency, status, provider_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(id, orgId, order.id, provider, intent.provider_transaction_id, body.method ? String(body.method).slice(0, 40) : null,
      order.total, order.currency, JSON.stringify({ instructions: intent.instructions }), t, t);
    logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "PAYMENT_CREATED", resourceType: "payment", resourceId: id, metadata: { provider, order_id: order.id, tx: intent.provider_transaction_id } });
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    return ctx.sendJSON(201, { payment: p, instructions: intent.instructions });
  }

  const segs = api[1] ? api[1].split("/").filter(Boolean) : [];
  const idPart = segs[0] || null;
  if (!idPart || idPart === "providers") return false;
  const p = isUuid(idPart) ? db.prepare("SELECT * FROM payments WHERE id = ? AND organization_id = ?").get(idPart, orgId) : null;
  if (!p) return ctx.sendJSON(404, { error: "Paiement introuvable." });

  if (method === "GET" && segs.length === 1) {
    if (!can(ctx.member.role, "crm:read")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    return ctx.sendJSON(200, { payment: p });
  }

  const sub = segs[1] || null;

  /* Annulation (PENDING uniquement) */
  if (method === "POST" && sub === "cancel") {
    if (!can(ctx.member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    if (p.status !== "PENDING") return ctx.sendJSON(409, { error: `Seul un paiement PENDING peut être annulé (statut : ${p.status}).` });
    db.prepare("UPDATE payments SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(nowIso(), p.id);
    logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "PAYMENT_CANCELLED", resourceType: "payment", resourceId: p.id });
    return ctx.sendJSON(200, { message: "Paiement annulé." });
  }

  /* Remboursement (CONFIRMED uniquement) — passage au fournisseur requis */
  if (method === "POST" && sub === "refund") {
    if (!can(ctx.member.role, "crm:delete")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:delete)." });
    if (p.status !== "CONFIRMED") return ctx.sendJSON(409, { error: `Seul un paiement CONFIRMED peut être remboursé (statut : ${p.status}).` });
    let ok = false;
    if (p.provider === "TEST" && isTestEnv()) ok = true;
    else {
      const cfg = PAYMENT_PROVIDERS[p.provider]?.configured?.() === true;
      if (!cfg) return ctx.sendJSON(409, { status: "CONFIGURATION_REQUIRED", message: "Le remboursement passe par le fournisseur — configuration requise (jamais simulé)." });
      // L'appel de remboursement réel s'effectue ici (API fournisseur) ; sans
      // intégration branchée, on ne rembourse pas (statut honnête).
      ok = false;
    }
    if (!ok) return ctx.sendJSON(409, { error: "Remboursement non effectué : intégration fournisseur non branchée." });
    db.prepare("UPDATE payments SET status = 'REFUNDED', updated_at = ? WHERE id = ?").run(nowIso(), p.id);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(p.order_id);
    if (order && ["PAID", "PROCESSING", "COMPLETED"].includes(order.status)) {
      db.prepare("UPDATE orders SET status = 'REFUNDED', updated_at = ? WHERE id = ?").run(nowIso(), order.id);
    }
    logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "PAYMENT_REFUNDED", resourceType: "payment", resourceId: p.id, metadata: { provider: p.provider } });
    return ctx.sendJSON(200, { message: "Paiement remboursé, commande en REFUNDED." });
  }

  /* Confirmation — UNiquement en APP_ENV=test (double de test, simule le webhook fournisseur) */
  if (method === "POST" && sub === "test-confirm" && isTestEnv() && p.provider === "TEST") {
    const v = verifyTransaction("TEST", { transactionId: p.provider_transaction_id });
    if (!v.ok) return ctx.sendJSON(400, { error: v.error });
    const confirmed = confirmPayment(db, orgId, p);
    return ctx.sendJSON(200, { payment: confirmed, message: "Paiement de test confirmé (double de test — APP_ENV=test)." });
  }
  if (method === "POST" && sub === "test-confirm") return ctx.sendJSON(404, { error: "Non disponible hors mode test." });

  return false;
}

/* ---------- Webhook fournisseur (signature HMAC + vérification transaction) ---------- */
export async function handleWebhook(ctx) {
  const { path, method, db, req } = ctx;
  const m = path.match(/^\/api\/webhooks\/payments\/([a-z_]+)$/i);
  if (!m || method !== "POST") return false;
  const provider = m[1].toUpperCase();
  if (!PAYMENT_PROVIDERS[provider]) return ctx.sendJSON(404, { error: "Fournisseur inconnu." });
  // Le double de test n'existe qu'en test
  if (provider === "TEST" && !isTestEnv()) return ctx.sendJSON(404, { error: "Non disponible." });
  // 1) Signature obligatoire — jamais de confiance aveugle
  const secret = webhookSecret(provider);
  if (!secret) {
    logAudit(db, { organizationId: null, userId: null, action: "PAYMENT_WEBHOOK_NO_SECRET", resourceType: "payment", metadata: { provider } });
    return ctx.sendJSON(401, { error: "Fournisseur non configuré (secret de webhook manquant)." });
  }
  const rawBody = typeof ctx.body?.__rawBody === "string" ? ctx.body.__rawBody : JSON.stringify(ctx.body || {});
  const provided = String(req.headers["x-provider-signature"] || "").replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const ba = Buffer.from(provided, "hex");
  const bb = Buffer.from(expected, "hex");
  if (ba.length !== bb.length || !timingSafeEqual(ba, bb)) {
    logAudit(db, { organizationId: null, userId: null, action: "PAYMENT_WEBHOOK_BAD_SIGNATURE", resourceType: "payment", metadata: { provider } });
    return ctx.sendJSON(401, { error: "Signature invalide." });
  }
  // 2) Résolution du paiement par l'ID fournisseur
  const tx = ctx.body?.transaction_id ? String(ctx.body.transaction_id).slice(0, 120) : null;
  const payment = tx ? db.prepare("SELECT * FROM payments WHERE provider = ? AND provider_transaction_id = ?").get(provider, tx) : null;
  if (!payment) {
    logAudit(db, { organizationId: null, userId: null, action: "PAYMENT_WEBHOOK_UNKNOWN", resourceType: "payment", metadata: { provider, tx: (tx || "").slice(0, 40) } });
    return ctx.sendJSON(404, { error: "Transaction inconnue." });
  }
  // 3) Vérification auprès du fournisseur (jamais de confiance au seul webhook)
  const v = verifyTransaction(provider, { transactionId: tx });
  if (!v.ok) {
    if (payment.status === "PENDING") db.prepare("UPDATE payments SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?").run(v.error, nowIso(), payment.id);
    fire(db, payment.organization_id, "PAYMENT_FAILED", payment.id, null, { payment_id: payment.id, provider, error: v.error });
    return ctx.sendJSON(400, { error: v.error });
  }
  if (payment.status !== "PENDING") {
    return ctx.sendJSON(200, { message: `Paiement déjà ${payment.status} (idempotence).` });
  }
  // 4) Confirmation + commande → PAID
  const confirmed = confirmPayment(db, payment.organization_id, payment);
  return ctx.sendJSON(200, { message: "Paiement confirmé.", payment_id: confirmed.id });
}

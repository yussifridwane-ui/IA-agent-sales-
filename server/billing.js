// server/billing.js — Phase 8 : moteur SaaS (plans, limites, trial, facturation)
// Principes :
//  - les limites sont appliquées CÔTÉ SERVEUR au point d'écriture (jamais
//    seulement dans l'UI) — réponse honnête (403 + message explicite), jamais
//    de blocage silencieux ;
//  - un compte n'est jamais « payant » sans confirmation RÉELLE d'un paiement
//    (webhook fournisseur — Phase 7) ;
//  - trial : statut 'trial' avec échéance ; à l'échéance → 'expired' + plan
//    FREE (rétrogradation honnête, lazy) ;
//  - downgrade = pris en fin de période (pending_plan) ; annulation = actif
//    jusqu'à fin de période, puis expired.
import { randomUUID } from "node:crypto";

const nowIso = () => new Date().toISOString();

export function getPlanDef(db, code) {
  if (!code) return null;
  const row = db.prepare("SELECT * FROM plan_definitions WHERE code = ?").get(String(code).toUpperCase());
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    price_monthly: row.price_monthly,
    price_annual: row.price_annual,
    currency: row.currency,
    limits: safeJson(row.limits, {}),
    features: safeJson(row.features, []),
    active: !!row.active,
    sort_order: row.sort_order,
  };
}

export function listPlanDefs(db, { includeInactive = false } = {}) {
  const rows = db.prepare("SELECT * FROM plan_definitions ORDER BY sort_order").all()
    .filter((r) => includeInactive || r.active);
  return rows.map((r) => ({
    code: r.code, name: r.name, price_monthly: r.price_monthly, price_annual: r.price_annual,
    currency: r.currency, limits: safeJson(r.limits, {}), features: safeJson(r.features, []),
    active: !!r.active, sort_order: r.sort_order,
  }));
}

function safeJson(s, fallback) {
  try { const v = JSON.parse(s || ""); return v ?? fallback; } catch { return fallback; }
}

/* ---------- Statut effectif de la subscription (lazy) ---------- */
/**
 * Renvoie la subscription avec le statut EFFECTIF :
 *  - 'trial' avec trial_ends_at dépassée → 'expired' (plan effectif : FREE)
 *  - 'active' annulée avec période dépassée → 'expired' (plan effectif : FREE)
 * Le plan effectif détermine les limites appliquées.
 */
export function effectiveSubscription(db, orgId) {
  let sub = db.prepare("SELECT * FROM subscriptions WHERE organization_id = ?").get(orgId) || null;
  if (!sub) {
    // Legacy : sans ligne, on considère un plan FREE actif (ne bloque pas les orgs existantes)
    return { plan: "FREE", effective_plan: "FREE", status: "active", trial_ends_at: null, current_period_end: null, pending_plan: null, cancelled_at: null };
  }
  const now = nowIso();
  let status = sub.status;
  let expired = false;
  if (status === "trial" && sub.trial_ends_at && sub.trial_ends_at < now) { status = "expired"; expired = true; }
  if (status === "active" && sub.cancelled_at && sub.current_period_end && sub.current_period_end < now) { status = "expired"; expired = true; }
  if (expired && status === "expired" && sub.status !== "expired") {
    db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now, sub.id);
  }
  // Downgrade différé pris en fin de période
  let pending_plan = sub.pending_plan || null;
  if (status === "active" && pending_plan && sub.current_period_end && sub.current_period_end < now) {
    db.prepare("UPDATE subscriptions SET plan = ?, pending_plan = NULL, updated_at = ? WHERE id = ?").run(pending_plan, now, sub.id);
    sub.plan = pending_plan;
    pending_plan = null;
  }
  const effective_plan = status === "expired" || status === "trial" ? (status === "trial" ? sub.plan : "FREE") : sub.plan;
  return {
    ...sub,
    status,
    effective_plan,
    pending_plan,
    trial_days_left: sub.trial_ends_at ? Math.max(0, Math.ceil((new Date(sub.trial_ends_at) - Date.now()) / 86400e3)) : null,
  };
}

/* ---------- Limites + usage ---------- */
export const METRIC_LABELS = {
  users: "Utilisateurs",
  leads: "Leads",
  ai_messages: "Messages IA / mois",
  conversations: "Conversations / mois",
  automations: "Automations actives",
  channels: "Canaux connectés",
  kb_documents: "Documents knowledge base",
};

/** Usage réel (SQL) par métrique pour l'organisation. */
export function planUsage(db, orgId) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const n = (sql, ...args) => db.prepare(sql).get(...args)?.n || 0;
  return {
    // active + invited : les invitations en attente comptent (sinon on pourrait
    // contourner la limite en invitant sans que les comptes n'existent)
    users: n("SELECT COUNT(*) n FROM organization_members WHERE organization_id = ? AND status IN ('active','invited')", orgId),
    leads: n("SELECT COUNT(*) n FROM leads WHERE organization_id = ?", orgId),
    ai_messages: n("SELECT COUNT(*) n FROM ai_usage WHERE organization_id = ? AND created_at >= ?", orgId, monthStart.toISOString()),
    conversations: n("SELECT COUNT(*) n FROM conversations WHERE organization_id = ? AND created_at >= ?", orgId, monthStart.toISOString()),
    automations: n("SELECT COUNT(*) n FROM automations WHERE organization_id = ? AND status = 'ACTIVE'", orgId),
    channels: n("SELECT COUNT(*) n FROM channel_connections WHERE organization_id = ? AND status = 'CONNECTED'", orgId),
    kb_documents: n("SELECT COUNT(*) n FROM knowledge_documents WHERE organization_id = ?", orgId),
  };
}

/**
 * Mode pilote : toutes les fonctionnalités ouvertes, sans carte bancaire
 * et sans limite d'usage. Actif par défaut hors APP_ENV=test.
 * Forcer avec PILOT_MODE=true|false.
 */
export function isPilotMode() {
  const v = String(process.env.PILOT_MODE || "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return process.env.APP_ENV !== "test";
}

/**
 * Vérifie une limite AVANT un point d'écriture.
 * Renvoie { ok } ou { ok: false, error } (message honnête, jamais de 500).
 * -1 (illimité) → toujours ok.
 * Mode pilote → toujours ok (limites non appliquées).
 */
export function checkLimit(db, orgId, metric, increment = 1) {
  if (isPilotMode()) {
    const usage = planUsage(db, orgId);
    return { ok: true, limit: null, used: usage[metric] || 0, pilot: true };
  }
  const eff = effectiveSubscription(db, orgId);
  const def = getPlanDef(db, eff.effective_plan) || getPlanDef(db, "FREE");
  const limit = def?.limits?.[metric];
  if (limit == null || limit < 0) return { ok: true, limit: null, used: null };
  const usage = planUsage(db, orgId);
  const used = usage[metric] || 0;
  if (used + increment > limit) {
    return {
      ok: false, limit, used,
      plan: eff.effective_plan,
      error: `Limite du plan ${eff.effective_plan} atteinte : ${METRIC_LABELS[metric] || metric} (${used}/${limit}). Passez à un plan supérieur pour continuer.`,
    };
  }
  return { ok: true, limit, used };
}

/* ---------- Factures ---------- */
export function invoiceNumber(db, orgId, year, offset = 0) {
  const n = db.prepare("SELECT COUNT(*) n FROM invoices WHERE organization_id = ? AND number LIKE ?").get(orgId, `INV-${year}-%`).n + 1 + offset;
  return `INV-${year}-${String(n).padStart(4, "0")}`;
}

/** Crée une facture OUVERTE pour une période de plan (montant réel du plan). */
export function createInvoice(db, orgId, { plan, periodStart, periodEnd, dueAt }) {
  const def = getPlanDef(db, plan);
  if (!def) return { error: "Plan inconnu." };
  const year = new Date().getFullYear();
  const id = randomUUID();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      db.prepare(
        `INSERT INTO invoices (id, organization_id, number, plan, period_start, period_end, amount, currency, status, due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`
      ).run(id, orgId, invoiceNumber(db, orgId, year, attempt), plan, periodStart, periodEnd,
        def.price_monthly, def.currency, dueAt, nowIso(), nowIso());
      break;
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
    }
  }
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
}

/**
 * Applique une confirmation de paiement sur une facture :
 * facture → PAID, subscription → plan du facture + statut 'active' + période.
 * (Appelé uniquement par le webhook paiement APRÈS vérification fournisseur.)
 */
export function applyPaidInvoice(db, orgId, invoiceId, paymentId) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ? AND organization_id = ?").get(invoiceId, orgId);
  if (!inv) return null;
  if (inv.status === "PAID") return inv; // idempotence
  db.prepare("UPDATE invoices SET status = 'PAID', payment_id = ?, updated_at = ? WHERE id = ?").run(paymentId, nowIso(), inv.id);
  db.prepare(
    `UPDATE subscriptions SET plan = ?, status = 'active', pending_plan = NULL, cancelled_at = NULL,
     current_period_start = COALESCE(?, current_period_start), current_period_end = COALESCE(?, current_period_end), updated_at = ?
     WHERE organization_id = ?`
  ).run(inv.plan, inv.period_start, inv.period_end, nowIso(), orgId);
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id);
}

/* ---------- Super-admin (spec §25) ---------- */
export function isSuperAdmin(db, userId) {
  return !!db.prepare("SELECT super_admin FROM users WHERE id = ?").get(userId)?.super_admin;
}

/** Marque super-admin l'utilisateur si son e-mail est dans SUPER_ADMIN_EMAILS (csv). */
export function maybeGrantSuperAdmin(db, userId, email) {
  const list = String(process.env.SUPER_ADMIN_EMAILS || process.env.SUPER_ADMIN_EMAIL || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes(String(email || "").toLowerCase())) {
    db.prepare("UPDATE users SET super_admin = 1 WHERE id = ?").run(userId);
    return true;
  }
  return false;
}

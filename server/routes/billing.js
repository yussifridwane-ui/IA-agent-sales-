// server/routes/billing.js — Phase 8 : API + page SaaS (plans, trial, facturation)
// RÈGLE ABSOLUE (spec §8) : un compte n'est « payant » (plan appliqué, statut
// active) qu'APRÈS confirmation RÉELLE d'un paiement par le fournisseur
// (webhook Phase 7). Sans fournisseur configuré → CONFIGURATION_REQUIRED
// honnête ; aucun plan payant, aucune facture « payée » n'est simulé.
import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import {
  getPlanDef, listPlanDefs, effectiveSubscription, planUsage, checkLimit,
  createInvoice, invoiceNumber, isSuperAdmin, METRIC_LABELS, isPilotMode,
} from "../billing.js";
import { providerStatus, createIntent, PAYMENT_PROVIDERS } from "../payments/providers.js";

const nowIso = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PAY_PROVIDERS = Object.keys(PAYMENT_PROVIDERS).filter((p) => p !== "TEST");

function usageDetail(db, orgId, eff) {
  const def = getPlanDef(db, eff.effective_plan) || getPlanDef(db, "FREE");
  const usage = planUsage(db, orgId);
  const pilot = isPilotMode();
  const details = {};
  for (const [metric, label] of Object.entries(METRIC_LABELS)) {
    const limit = def?.limits?.[metric];
    const unlimited = pilot || limit == null || limit < 0;
    const used = usage[metric] || 0;
    details[metric] = {
      label,
      used,
      limit: unlimited ? null : limit,
      unlimited,
      remaining: unlimited ? null : Math.max(0, limit - used),
      pct: unlimited ? null : Math.min(100, Math.round((used / Math.max(1, limit)) * 100)),
      pilot,
    };
  }
  return details;
}

function invoicesOf(db, orgId) {
  return db.prepare("SELECT * FROM invoices WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100").all(orgId);
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;

  /* ---------- Plans (public — tarifs configurables, spec §7) ---------- */
  if (path === "/api/plans" && method === "GET") {
    return ctx.sendJSON(200, { plans: listPlanDefs(db) });
  }
  const planEdit = path.match(/^\/api\/plans\/([a-z0-9_-]+)$/i);
  if (planEdit && method === "PUT") {
    // Configuration des prix/limites : SUPER-ADMIN uniquement (spec §25)
    if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
    if (!isSuperAdmin(db, ctx.user.id)) return ctx.sendJSON(403, { error: "Réservé au super-administrateur." });
    const code = planEdit[1].toUpperCase();
    const def = getPlanDef(db, code);
    if (!def) return ctx.sendJSON(404, { error: "Plan inconnu." });
    const errors = [];
    const next = { ...def };
    if (body.name !== undefined) { const v = String(body.name).slice(0, 60); if (!v) errors.push("nom requis"); else next.name = v; }
    for (const f of ["price_monthly", "price_annual"]) {
      if (body[f] !== undefined) {
        const v = Number(body[f]);
        if (!Number.isFinite(v) || v < 0) errors.push(`${f} invalide`); else next[f] = v;
      }
    }
    if (body.currency !== undefined) { const v = String(body.currency).toUpperCase().slice(0, 8); if (v.length < 3) errors.push("devise invalide"); else next.currency = v; }
    if (body.limits !== undefined && typeof body.limits === "object") {
      const merged = { ...def.limits };
      for (const k of Object.keys(def.limits)) {
        if (body.limits[k] !== undefined) {
          const v = Number(body.limits[k]);
          if (!Number.isFinite(v) || v < -1) errors.push(`limites.${k} invalide`); else merged[k] = Math.trunc(v);
        }
      }
      next.limits = merged;
    }
    if (body.features !== undefined && Array.isArray(body.features)) next.features = body.features.slice(0, 20).map((f) => String(f).slice(0, 120));
    if (body.active !== undefined) next.active = body.active ? 1 : 0;
    if (errors.length) return ctx.sendJSON(400, { error: errors.join(" ") });
    const t = nowIso();
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(next)) {
      if (k === "code" || k === "updated_at") continue;
      sets.push(`${k} = ?`);
      // node:sqlite ne lie que number/string/null : booleans → 0/1, objets → JSON
      params.push(k === "active" ? (v ? 1 : 0) : (typeof v === "object" && v !== null ? JSON.stringify(v) : v));
    }
    sets.push("updated_at = ?"); params.push(t, code);
    db.prepare(`UPDATE plan_definitions SET ${sets.join(", ")} WHERE code = ?`).run(...params);
    logAudit(db, { organizationId: null, userId: ctx.user.id, action: "UPDATE_PLAN", resourceType: "plan", resourceId: code, metadata: { fields: Object.keys(body) } });
    return ctx.sendJSON(200, { plan: getPlanDef(db, code), message: "Plan mis à jour." });
  }

  if (path.startsWith("/api/billing")) {
    if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
    if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
    // Re-scope multi-tenant : ?organization_id=… uniquement si membre (sinon 403)
    const requestedOrg = ctx.query.organization_id;
    if (requestedOrg) {
      const m = isUuid(requestedOrg) ? db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(requestedOrg, ctx.user.id) : null;
      const o = m ? db.prepare("SELECT * FROM organizations WHERE id = ?").get(requestedOrg) : null;
      if (!m || !o) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
      ctx.org = o;
      ctx.member = m;
    }
    const orgId = ctx.org.id;
    const eff = effectiveSubscription(db, orgId);

    /* Vue facturation (plan + statut + usage + factures) */
    if (path === "/api/billing" && method === "GET") {
      if (!can(ctx.member.role, "dashboard:read")) return ctx.sendJSON(403, { error: "Permission insuffisante." });
      const invoices = invoicesOf(db, orgId);
      return ctx.sendJSON(200, {
        plan: eff.plan,
        effective_plan: eff.effective_plan,
        status: eff.status,
        pilot: isPilotMode(),
        trial: { ends_at: eff.trial_ends_at || null, days_left: eff.trial_days_left, plan: eff.status === "trial" ? eff.plan : null },
        period: { start: eff.current_period_start || null, end: eff.current_period_end || null },
        cancelled_at: eff.cancelled_at || null,
        pending_plan: eff.pending_plan || null,
        usage: usageDetail(db, orgId, eff),
        plans: listPlanDefs(db),
        providers: providerStatus().filter((p) => p.provider !== "TEST"),
        invoices,
      });
    }

    /* ---------- Upgrade : facturation réelle (jamais simulée) ---------- */
    if (path === "/api/billing/upgrade" && method === "POST") {
      if (!can(ctx.member.role, "org:update")) return ctx.sendJSON(403, { error: "Permission insuffisante (org:update)." });
      const plan = String(body.plan || "").toUpperCase();
      const def = getPlanDef(db, plan);
      if (!def || !def.active) return ctx.sendJSON(400, { error: "Plan inconnu ou inactif." });
      if (def.price_monthly <= 0) return ctx.sendJSON(400, { error: `Le plan ${def.code} ne nécessite pas de paiement (sur devis — contactez-nous).` });
      // Pas d'upgrade vers un plan moins cher (utiliser /downgrade)
      const cur = getPlanDef(db, eff.effective_plan);
      if (cur && def.price_monthly <= cur.price_monthly) return ctx.sendJSON(400, { error: "Ce plan est moins cher que le plan actuel — utilisez le downgrade." });
      const provider = String(body.provider || "").toUpperCase();
      // Le double de test n'est utilisable qu'en APP_ENV=test (jamais en production)
      const allowedProviders = process.env.APP_ENV === "test" ? [...PAY_PROVIDERS, "TEST"] : PAY_PROVIDERS;
      if (!allowedProviders.includes(provider)) return ctx.sendJSON(400, { error: `Fournisseur de paiement requis (${allowedProviders.filter((p) => p !== "TEST").join(", ")}).` });
      const ps = providerStatus().find((p) => p.provider === provider);
      if (!ps || ps.status !== "CONNECTED") {
        return ctx.sendJSON(409, {
          status: "CONFIGURATION_REQUIRED", provider,
          needs: ps?.needs || [`clé API ${provider}`],
          message: `Fournisseur ${provider} non configuré : ${ps?.needs?.join(" + ") || "clé API requise"}. Aucun paiement n'est créé (jamais simulé).`,
        });
      }
      // Période de 30 jours à partir de maintenant
      const start = nowIso();
      const end = new Date(Date.now() + 30 * 86400e3).toISOString();
      const invoice = createInvoice(db, orgId, { plan, periodStart: start, periodEnd: end, dueAt: end });
      const intent = await createIntent({ provider, order: null, invoice, method: body.method });
      if (intent.status === "CONFIGURATION_REQUIRED") {
        db.prepare("UPDATE invoices SET status = 'VOID', updated_at = ? WHERE id = ?").run(nowIso(), invoice.id);
        return ctx.sendJSON(409, { status: "CONFIGURATION_REQUIRED", needs: intent.needs, message: "Fournisseur indisponible : " + (intent.error || "configuration requise") });
      }
      if (intent.status !== "PENDING") {
        db.prepare("UPDATE invoices SET status = 'VOID', updated_at = ? WHERE id = ?").run(nowIso(), invoice.id);
        return ctx.sendJSON(502, { error: intent.error || "Création de l'intention de paiement impossible." });
      }
      // Paiement PENDING (confirmé uniquement par le webhook fournisseur)
      const randomUUID = (await import("node:crypto")).randomUUID;
      const payId = randomUUID();
      db.prepare(
        `INSERT INTO payments (id, organization_id, order_id, invoice_id, provider, provider_transaction_id, method, amount, currency, status, provider_payload, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
      ).run(payId, orgId, invoice.id, provider, intent.provider_transaction_id, body.method ? String(body.method).slice(0, 40) : null,
        invoice.amount, invoice.currency, JSON.stringify({ instructions: intent.instructions }), nowIso(), nowIso());
      logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "BILLING_UPGRADE_INITIATED", resourceType: "invoice", resourceId: invoice.id, metadata: { plan, provider, invoice: invoice.number } });
      return ctx.sendJSON(200, {
        status: "PENDING",
        invoice: { id: invoice.id, number: invoice.number, plan, amount: invoice.amount, currency: invoice.currency, status: invoice.status },
        payment: { id: payId, provider_transaction_id: intent.provider_transaction_id, status: "PENDING" },
        instructions: intent.instructions,
        message: `Paiement de ${invoice.amount} ${invoice.currency} en attente de confirmation par ${provider}. Le plan ${plan} sera activé après confirmation (jamais avant).`,
      });
    }

    /* ---------- Downgrade : pris en fin de période (honorable, sans rétroactivité) ---------- */
    if (path === "/api/billing/downgrade" && method === "POST") {
      if (!can(ctx.member.role, "org:update")) return ctx.sendJSON(403, { error: "Permission insuffisante (org:update)." });
      const plan = String(body.plan || "").toUpperCase();
      const def = getPlanDef(db, plan);
      if (!def || !def.active) return ctx.sendJSON(400, { error: "Plan inconnu ou inactif." });
      const cur = getPlanDef(db, eff.effective_plan);
      if (!cur || def.price_monthly >= cur.price_monthly) return ctx.sendJSON(400, { error: "Ce plan n'est pas moins cher que le plan actuel." });
      db.prepare("UPDATE subscriptions SET pending_plan = ?, updated_at = ? WHERE organization_id = ?").run(plan, nowIso(), orgId);
      logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "BILLING_DOWNGRADE_SCHEDULED", resourceType: "subscription", resourceId: orgId, metadata: { plan } });
      return ctx.sendJSON(200, {
        pending_plan: plan,
        message: `Downgrade en ${plan} pris en fin de période (${eff.current_period_end ? eff.current_period_end.slice(0, 10) : "prochaine échéance"}). Aucune facturation rétroactive.`,
      });
    }

    /* ---------- Annulation : actif jusqu'à fin de période, puis expired ---------- */
    if (path === "/api/billing/cancel" && method === "POST") {
      if (!can(ctx.member.role, "org:update")) return ctx.sendJSON(403, { error: "Permission insuffisante (org:update)." });
      if (eff.status === "trial") {
        // Annuler le trial = passage direct au plan FREE (honnête, immédiat)
        db.prepare("UPDATE subscriptions SET plan = 'FREE', status = 'active', trial_ends_at = NULL, trial_days = NULL, current_period_start = NULL, current_period_end = NULL, updated_at = ? WHERE organization_id = ?").run(nowIso(), orgId);
        logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "BILLING_TRIAL_CANCELLED", resourceType: "subscription", resourceId: orgId });
        return ctx.sendJSON(200, { message: "Trial annulé : l'organisation passe au plan Gratuit." });
      }
      if (eff.status !== "active" || eff.cancelled_at) return ctx.sendJSON(409, { error: "Aucun abonnement actif à annuler." });
      db.prepare("UPDATE subscriptions SET cancelled_at = ?, updated_at = ? WHERE organization_id = ?").run(nowIso(), nowIso(), orgId);
      logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "BILLING_CANCELLED", resourceType: "subscription", resourceId: orgId, metadata: { until: eff.current_period_end } });
      return ctx.sendJSON(200, {
        message: `Annulation enregistrée : l'abonnement reste actif jusqu'au ${eff.current_period_end ? eff.current_period_end.slice(0, 10) : "prochain renouvellement"}, puis passe au plan Gratuit.`,
      });
    }

    /* ---------- Factures ---------- */
    if (path === "/api/billing/invoices" && method === "GET") {
      if (!can(ctx.member.role, "dashboard:read")) return ctx.sendJSON(403, { error: "Permission insuffisante." });
      return ctx.sendJSON(200, { invoices: invoicesOf(db, orgId) });
    }

    /* ---------- Super-admin : suivi des organisations (fondation spec §25) ---------- */
    if (path === "/api/billing/admin" && method === "GET") {
      if (!ctx.user || !isSuperAdmin(db, ctx.user.id)) return ctx.sendJSON(403, { error: "Réservé au super-administrateur." });
      const rows = db.prepare(
        `SELECT o.id, o.name, o.country, s.plan, s.status, s.trial_ends_at, s.current_period_end, s.cancelled_at, s.pending_plan,
                (SELECT COUNT(*) FROM leads l WHERE l.organization_id = o.id) AS leads,
                (SELECT COUNT(*) FROM ai_usage a WHERE a.organization_id = o.id) AS ai_messages,
                (SELECT COALESCE(SUM(i.amount), 0) FROM invoices i WHERE i.organization_id = o.id AND i.status = 'PAID') AS revenue_paid
         FROM organizations o LEFT JOIN subscriptions s ON s.organization_id = o.id
         ORDER BY o.created_at DESC LIMIT 200`
      ).all();
      return ctx.sendJSON(200, { organizations: rows });
    }
    const adminOrg = path.match(/^\/api\/billing\/admin\/organizations\/([0-9a-f-]+)$/i);
    if (adminOrg && method === "PUT") {
      if (!ctx.user || !isSuperAdmin(db, ctx.user.id)) return ctx.sendJSON(403, { error: "Réservé au super-administrateur." });
      const orgId2 = adminOrg[1];
      const org2 = isUuid(orgId2) ? db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId2) : null;
      if (!org2) return ctx.sendJSON(404, { error: "Organisation inconnue." });
      const plan = String(body.plan || "").toUpperCase();
      const def = getPlanDef(db, plan);
      if (!def) return ctx.sendJSON(400, { error: "Plan inconnu." });
      const trialDays = body.trial_days !== undefined ? Math.max(0, Math.min(365, Number(body.trial_days) || 0)) : null;
      const t = nowIso();
      if (trialDays !== null && trialDays > 0) {
        db.prepare(
          `INSERT INTO subscriptions (id, organization_id, plan, status, current_period_start, trial_days, trial_ends_at, created_at, updated_at)
           VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, ?)
           ON CONFLICT(organization_id) DO UPDATE SET plan = excluded.plan, status = 'trial', trial_days = excluded.trial_days, trial_ends_at = excluded.trial_ends_at, cancelled_at = NULL, pending_plan = NULL, updated_at = excluded.updated_at`
        ).run((db.prepare("SELECT id FROM subscriptions WHERE organization_id = ?").get(orgId2)?.id) || (await import("node:crypto")).randomUUID(), orgId2, plan, t, trialDays, new Date(Date.now() + trialDays * 86400e3).toISOString(), t, t);
      } else {
        db.prepare(
          `INSERT INTO subscriptions (id, organization_id, plan, status, current_period_start, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)
           ON CONFLICT(organization_id) DO UPDATE SET plan = excluded.plan, status = 'active', current_period_start = excluded.current_period_start, cancelled_at = NULL, pending_plan = NULL, updated_at = excluded.updated_at`
        ).run((db.prepare("SELECT id FROM subscriptions WHERE organization_id = ?").get(orgId2)?.id) || (await import("node:crypto")).randomUUID(), orgId2, plan, t, t, t);
      }
      logAudit(db, { organizationId: orgId2, userId: ctx.user.id, action: "ADMIN_SET_PLAN", resourceType: "subscription", resourceId: orgId2, metadata: { plan, trial_days: trialDays } });
      return ctx.sendJSON(200, { message: `Plan ${plan} appliqué${trialDays ? ` (trial ${trialDays} j)` : ""}.` });
    }
  }
  return false;
}

/* ---------- Page /dashboard/billing ---------- */
export async function handlePage(ctx) {
  const { path } = ctx;
  if (path !== "/dashboard/billing") return false;
  if (!ctx.user || !ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  // Re-scope multi-tenant (cohérent avec l'API)
  const requestedOrg = ctx.query.organization_id;
  if (requestedOrg) {
    const m = isUuid(requestedOrg) ? ctx.db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(requestedOrg, ctx.user.id) : null;
    const o = m ? ctx.db.prepare("SELECT * FROM organizations WHERE id = ?").get(requestedOrg) : null;
    if (!m || !o) { ctx.sendHTML(403, "<h1>403 — Accès refusé à cette organisation</h1>"); return true; }
    ctx.org = o;
    ctx.member = m;
  }
  if (!can(ctx.member.role, "dashboard:read")) { ctx.sendHTML(403, "<h1>403 — Permission insuffisante</h1>"); return true; }
  const db = ctx.db;
  const eff = effectiveSubscription(db, ctx.org.id);
  const { billingPage } = await import("../views/billing.js");
  return ctx.sendHTML(200, billingPage({
    user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf,
    billing: {
      plan: eff.plan,
      effective_plan: eff.effective_plan,
      status: eff.status,
      pilot: isPilotMode(),
      trial: { ends_at: eff.trial_ends_at || null, days_left: eff.trial_days_left, plan: eff.status === "trial" ? eff.plan : null },
      period: { start: eff.current_period_start || null, end: eff.current_period_end || null },
      cancelled_at: eff.cancelled_at || null,
      pending_plan: eff.pending_plan || null,
      usage: usageDetail(db, ctx.org.id, eff),
      plans: listPlanDefs(db),
      providers: providerStatus().filter((p) => p.provider !== "TEST"),
      invoices: db.prepare("SELECT * FROM invoices WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100").all(ctx.org.id),
    },
  }));
}

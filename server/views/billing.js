// server/views/billing.js — Phase 8 : page /dashboard/billing
// Plan actuel + statut (trial/actif/expiré), usage (Utilisé/Limite/Restant),
// plans (upgrade/downgrade), fournisseurs (état honnête), factures (réelles).
import { esc } from "../security.js";
import { appLayout } from "./app.js";

const STATUS_LABEL = {
  trial: ["#8b5cf6", "Trial"],
  active: ["#16a34a", "Actif"],
  expired: ["#f59e0b", "Expiré"],
  cancelled: ["#dc2626", "Annulé"],
};
const INVOICE_LABEL = { OPEN: ["#f59e0b", "En attente"], PAID: ["#16a34a", "Payée"], VOID: ["#94a3b8", "Annulée"] };

export function billingPage({ user, org, role, path, csrf, billing }) {
  const canManage = ["OWNER", "ADMIN"].includes(role);
  const [sColor, sLabel] = STATUS_LABEL[billing.status] || STATUS_LABEL.active;
  const currentPlan = billing.plans.find((p) => p.code === billing.effective_plan);
  const pilotBanner = billing.pilot
    ? `<div class="pilot-banner"><b>PILOT_MODE = TRUE</b> — le pilote est gratuit : organisations et utilisateurs illimités, agent IA inclus, aucune carte bancaire. Les limites de plan ne s'appliquent pas.</div>`
    : "";

  const usageRows = Object.entries(billing.usage).map(([metric, u]) => {
    const pct = u.pct == null ? null : Math.min(100, u.pct);
    const barColor = pct == null ? "#16a34a" : pct >= 90 ? "#dc2626" : pct >= 70 ? "#f59e0b" : "#16a34a";
    return `
    <tr>
      <td>${esc(u.label)}</td>
      <td class="num"><b>${u.unlimited ? "∞" : esc(u.used)}</b>${u.unlimited ? "" : ` / ${esc(u.limit)}`}</td>
      <td class="num">${u.unlimited ? "Illimité" : `${u.remaining} restant(s)`}</td>
      <td style="min-width:120px">
        ${u.unlimited ? '<span class="muted-sm">—</span>' : `
        <div style="background:var(--soft,#f1f5f9);border-radius:999px;height:8px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:999px"></div>
        </div>`}
      </td>
    </tr>`;
  }).join("");

  const planCards = billing.plans.map((p) => {
    const isCurrent = p.code === billing.effective_plan;
    const isTrialPlan = billing.status === "trial" && p.code === billing.plan;
    const price = p.code === "ENTERPRISE" || Number(p.price_monthly) === 0 ? "Sur devis" : `${esc(p.price_monthly)} ${esc(p.currency)} / mois`;
    const cheaper = currentPlan && Number(p.price_monthly) < Number(currentPlan.price_monthly);
    return `
    <div class="card" style="padding:16px;${isCurrent ? "border-color:#4f46e5;box-shadow:0 0 0 2px color-mix(in srgb,#4f46e5 25%,transparent)" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">${esc(p.name)}</h3>
        ${isCurrent ? '<span class="pill" style="color:#4f46e5">Plan actuel</span>' : (isTrialPlan ? '<span class="pill" style="color:#8b5cf6">Trial</span>' : "")}
      </div>
      <div style="font-size:18px;font-weight:700;margin:8px 0">${price}</div>
      <ul style="font-size:13px;color:var(--muted,#64748b);margin:0 0 12px;padding-left:18px;line-height:1.7">
        ${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}
      </ul>
      ${canManage && !isCurrent ? `
      <button class="btn ${cheaper ? "ghost" : "primary"} block" data-plan="${esc(p.code)}" data-type="${cheaper ? "downgrade" : "upgrade"}">
        ${cheaper ? "Passer à ce plan" : "Mettre à niveau"}
      </button>` : ""}
    </div>`;
  }).join("");

  const providerRows = billing.providers.map((p) => `
    <tr>
      <td>${esc(p.label)}</td>
      <td>${p.status === "CONNECTED" ? '<span class="pill" style="color:#16a34a">CONNECTED</span>' : '<span class="pill" style="color:#f59e0b">CONFIGURATION_REQUIRED</span>'}${p.needs && p.needs.length ? `<div class="muted-sm">${p.needs.map(esc).join("<br/>")}</div>` : ""}</td>
    </tr>`).join("");

  const invoiceRows = (billing.invoices || []).map((i) => {
    const [c, l] = INVOICE_LABEL[i.status] || INVOICE_LABEL.OPEN;
    return `
    <tr>
      <td><b>${esc(i.number)}</b></td>
      <td>${esc(i.plan || "")}</td>
      <td>${esc((i.period_start || "").slice(0, 10))} → ${esc((i.period_end || "").slice(0, 10))}</td>
      <td class="num">${esc(i.amount)} ${esc(i.currency)}</td>
      <td><span class="pill" style="color:${c};background:color-mix(in srgb, ${c} 12%, transparent)">${l}</span></td>
      <td class="muted-sm">${esc((i.created_at || "").slice(0, 10))}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="6" class="muted">Aucune facture. Les factures « Payée » n’apparaissent qu’après confirmation réelle d’un paiement.</td></tr>';

  const trialInfo = billing.status === "trial"
    ? `<div class="card" style="padding:14px 16px;margin-bottom:16px;background:color-mix(in srgb,#8b5cf6 8%,var(--card,#fff));border-color:#8b5cf6">
        <b>🧪 Essai gratuit</b> — plan ${esc(billing.plan)} pendant <b>${billing.trial.days_left} jour(s)</b> (fin le ${esc((billing.trial.ends_at || "").slice(0, 10))}).
        <span class="muted-sm">À l’échéance, l’organisation passera au plan Gratuit tant qu’aucun paiement n’est confirmé.</span>
        ${canManage ? ` <button class="btn ghost" id="cancel-trial" style="margin-left:8px">Annuler l’essai</button>` : ""}
      </div>`
    : "";

  const cancelInfo = billing.status === "active" && billing.cancelled_at
    ? `<div class="card" style="padding:12px 16px;margin-bottom:16px;background:color-mix(in srgb,#dc2626 8%,var(--card,#fff));border-color:#dc2626">
        <b>Annulation programmée</b> — l’abonnement reste actif jusqu’au ${esc((billing.period.end || "").slice(0, 10))}, puis plan Gratuit.
      </div>`
    : "";

  const pendingInfo = billing.pending_plan
    ? `<div class="card" style="padding:12px 16px;margin-bottom:16px">
        <b>Downgrade programmé</b> — passage au plan ${esc(billing.pending_plan)} en fin de période (${esc((billing.period.end || "").slice(0, 10))}).
      </div>`
    : "";

  const content = `
<section class="page-head">
  <div><h2>Facturation & plan</h2><p class="muted">Plan, utilisation et factures de votre organisation. Un plan payant n’est activé qu’après <b>confirmation réelle</b> d’un paiement (fournisseur) — jamais de statut « payé » simulé.</p></div>
  <span class="pill" style="font-size:14px;color:${sColor};background:color-mix(in srgb, ${sColor} 12%, transparent)">${sLabel} · ${esc(currentPlan?.name || billing.effective_plan)}</span>
</section>
${pilotBanner}${trialInfo}${cancelInfo}${pendingInfo}
<div class="card" style="margin-bottom:16px">
  <h3 style="margin-top:0">Utilisation (plan ${esc(billing.effective_plan)})</h3>
  <table class="tbl">
    <thead><tr><th>Ressource</th><th class="num">Utilisé / Limite</th><th class="num">Restant</th><th></th></tr></thead>
    <tbody>${usageRows}</tbody>
  </table>
  <p class="muted-sm" style="margin-top:8px">Les limites sont appliquées côté serveur au point d’écriture. En cas de dépassement, une réponse explicite vous invite à passer à un plan supérieur (aucun blocage silencieux).</p>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-bottom:16px">
  ${planCards}
</div>
<div class="card" style="margin-bottom:16px">
  <h3 style="margin-top:0">Fournisseurs de paiement (état honnête)</h3>
  <table class="tbl"><thead><tr><th>Fournisseur</th><th>État</th></tr></thead><tbody>${providerRows}</tbody></table>
  ${canManage ? `<div style="margin-top:12px" id="provider-msg"></div>` : ""}
</div>
<div class="card">
  <h3 style="margin-top:0">Factures</h3>
  <table class="tbl">
    <thead><tr><th>N°</th><th>Plan</th><th>Période</th><th class="num">Montant</th><th>Statut</th><th>Créée</th></tr></thead>
    <tbody>${invoiceRows}</tbody>
  </table>
</div>
${canManage ? `<script>
(function () {
  "use strict";
  var CSRF = ${JSON.stringify(csrf)};
  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, "X-Requested-With": "fetch" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  document.querySelectorAll("button[data-plan]").forEach(function (b) {
    b.addEventListener("click", function () {
      var plan = b.dataset.plan, type = b.dataset.type;
      if (type === "downgrade") {
        if (!confirm("Passer au plan " + plan + " en fin de période ? (aucune facturation rétroactive)")) return;
        api("/api/billing/downgrade", { plan: plan }).then(function (j) { alert(j.message || j.error || "OK"); location.reload(); });
        return;
      }
      // Upgrade : choix du fournisseur
      api("/api/billing").then(function (j) {
        var ps = (j.providers || []).filter(function (p) { return p.status === "CONNECTED"; });
        if (!ps.length) { alert("Aucun fournisseur de paiement CONFIGURÉ (CONFIGURATION_REQUIRED). Aucun paiement ne peut être créé — jamais simulé."); return; }
        var provider = ps.length === 1 ? ps[0].provider : prompt("Fournisseur de paiement :\\n" + ps.map(function (p) { return p.provider + " — " + p.label; }).join("\\n"), ps[0].provider);
        if (!provider) return;
        api("/api/billing/upgrade", { plan: plan, provider: provider }).then(function (j2) {
          if (j2.status === "CONFIGURATION_REQUIRED") { alert(j2.message || "Configuration requise."); }
          else if (j2.status === "PENDING") { alert(j2.message); location.reload(); }
          else { alert(j2.error || "Échec"); }
        });
      });
    });
  });
  var ct = document.getElementById("cancel-trial");
  if (ct) ct.addEventListener("click", function () {
    if (!confirm("Annuler l'essai ? L'organisation passera immédiatement au plan Gratuit.")) return;
    api("/api/billing/cancel", {}).then(function (j) { alert(j.message || j.error || "OK"); location.reload(); });
  });
})();
</script>` : ""}`;
  return appLayout({ title: "Facturation", user, org, role, path, csrf, content });
}

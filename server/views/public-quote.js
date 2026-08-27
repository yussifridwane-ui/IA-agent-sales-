// server/views/public-quote.js — Phase 7 : page publique du devis /quote/<token>
// Le client n'a pas besoin de compte : il consulte, puis accepte ou rejette.
// Aucune donnée sensible (seuls : org, client, lignes, totaux, validité).
import { esc } from "../security.js";

export function publicQuotePage({ q, state, org = null, currency = "XOF", customer = null, items = [] }) {
  const statusText = {
    draft: ["⏳", "Ce devis n'a pas encore été envoyé. Vous serez notifié dès qu'il sera disponible.", false],
    open: ["📄", `Devis ${esc(q.number)} — en attente de votre décision`, true],
    expired: ["⌛", `Ce devis a expiré le ${esc((q.valid_until || "").slice(0, 10) || "—")}. Contactez-nous pour une mise à jour.`, false],
    accepted: ["✅", "Devis accepté — merci ! Notre équipe vous contacte pour finaliser la commande.", false],
    rejected: ["", "Devis refusé — nous en prenons bonne note.", false],
  };
  const [icon, title, actionable] = statusText[state] || statusText.open;
  const rows = items.map((it, i) => `
    <tr>
      <td>${i + 1}. ${esc(it.name)}</td>
      <td class="num">${esc(it.quantity)}</td>
      <td class="num">${esc(it.unit_price)} ${esc(currency)}</td>
      <td class="num">${esc(it.total)} ${esc(currency)}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>${esc(q.number)} · Devis</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #eef1f6; color: #0f172a; padding: 24px 12px; }
  .doc { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 16px; box-shadow: 0 12px 40px rgba(15,23,42,.14); overflow: hidden; }
  .head { background: #4f46e5; color: #fff; padding: 22px 26px; }
  .head .k { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
  .head h1 { font-size: 22px; margin-top: 6px; }
  .body { padding: 24px 26px; }
  .status { border-radius: 12px; padding: 14px 16px; font-size: 14.5px; margin-bottom: 18px; }
  .status.open { background: #eef2ff; color: #3730a3; }
  .status.draft, .status.expired { background: #fef3c7; color: #92400e; }
  .status.accepted { background: #dcfce7; color: #166534; }
  .status.rejected { background: #f1f5f9; color: #475569; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 18px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .grid h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin-bottom: 6px; }
  .grid p { font-size: 14px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; padding: 8px 6px; border-bottom: 2px solid #e2e8f0; }
  td { padding: 9px 6px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 14px; margin-left: auto; width: 260px; font-size: 14px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .row.total { border-top: 2px solid #0f172a; margin-top: 6px; padding-top: 8px; font-size: 16px; font-weight: 700; }
  .actions { display: flex; gap: 10px; margin-top: 22px; flex-wrap: wrap; }
  .actions button { flex: 1; min-width: 160px; border: 0; border-radius: 12px; padding: 14px 18px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .actions .accept { background: #16a34a; color: #fff; }
  .actions .reject { background: #fff; color: #dc2626; border: 1px solid #fecaca; }
  .actions button:disabled { opacity: .6; cursor: default; }
  .notes { margin-top: 16px; font-size: 13px; color: #475569; background: #f8fafc; border-radius: 10px; padding: 12px; }
  .foot { padding: 14px 26px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<div class="doc">
  <div class="head">
    <div class="k">${esc(org?.name || "AI Sales Agent")} · Devis</div>
    <h1>${esc(q.number)}</h1>
  </div>
  <div class="body">
    <div class="status ${state}">${icon} ${title}</div>
    ${state === "open" || state === "accepted" || state === "rejected" ? `
    <div class="grid">
      <div><h4>Émis</h4><p>${esc(q.created_at.slice(0, 10))}</p></div>
      <div><h4>Client</h4><p>${esc(customer ? `${customer.first_name} ${customer.last_name}`.trim() : "—")}${customer?.email ? `<br/>${esc(customer.email)}` : ""}</p></div>
      <div><h4>Valable jusqu'au</h4><p>${esc((q.valid_until || "").slice(0, 10) || "—")}</p></div>
      <div><h4>Devise</h4><p>${esc(currency)}</p></div>
    </div>
    <table>
      <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">P.U.</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Sous-total</span><span>${esc(q.subtotal)} ${esc(currency)}</span></div>
      ${Number(q.discount) > 0 ? `<div class="row"><span>Remise</span><span>−${esc(q.discount)} ${esc(currency)}</span></div>` : ""}
      ${Number(q.tax) > 0 ? `<div class="row"><span>Taxes</span><span>${esc(q.tax)} ${esc(currency)}</span></div>` : ""}
      <div class="row total"><span>TOTAL</span><span>${esc(q.total)} ${esc(currency)}</span></div>
    </div>
    ${q.notes ? `<div class="notes">${esc(q.notes)}</div>` : ""}
    ${actionable ? `
    <div class="actions">
      <button class="accept" id="btn-accept">✓ Accepter le devis</button>
      <button class="reject" id="btn-reject">Refuser</button>
    </div>` : ""}
    ` : ""}
  </div>
  <div class="foot">Document généré par AI Sales Agent — ${esc(q.number)} · ${esc(q.created_at.slice(0, 10))}</div>
</div>
${actionable ? `<script>
(function () {
  "use strict";
  var TOKEN = ${JSON.stringify(q.access_token)};
  function decide(decision) {
    var reason = null;
    if (decision === "reject") {
      reason = window.prompt("Pourquoi refusez-vous ce devis ? (optionnel)") || null;
    }
    fetch("/quote/" + encodeURIComponent(TOKEN) + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: decision, reason: reason }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      alert(j.message || j.error || "OK");
      location.reload();
    }).catch(function () { alert("Erreur réseau — réessayez."); });
  }
  document.getElementById("btn-accept").addEventListener("click", function () {
    if (confirm("Confirmez-vous l'acceptation du devis ?")) decide("accept");
  });
  document.getElementById("btn-reject").addEventListener("click", function () { decide("reject"); });
})();
</script>` : ""}
</body>
</html>`;
}

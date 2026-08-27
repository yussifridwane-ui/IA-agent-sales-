// server/views/commerce.js — Phase 7 : pages Devis + Commandes
// (JS fetch ; les prix des lignes viennent du catalogue côté serveur)
import { esc } from "../security.js";
import { appLayout } from "./app.js";

/* ================= DEVIS ================= */
export function quotesPage({ user, org, role, path, csrf, quotes, customers, leads, products, currency }) {
  const canWrite = ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"].includes(role);
  const STATUS = { DRAFT: ["#64748b", "Brouillon"], SENT: ["#3b82f6", "Envoyé"], VIEWED: ["#8b5cf6", "Consulté"], ACCEPTED: ["#16a34a", "Accepté"], REJECTED: ["#dc2626", "Refusé"], EXPIRED: ["#f59e0b", "Expiré"], CANCELLED: ["#94a3b8", "Annulé"] };
  const rows = quotes.map((q) => {
    const [color, label] = STATUS[q.status] || STATUS.DRAFT;
    return `
    <tr>
      <td><b>${esc(q.number)}</b></td>
      <td>${esc(q.customer_name || q.lead_name || "—")}</td>
      <td>${q.items_count} ligne(s)</td>
      <td>${esc(q.total)} ${esc(q.currency || currency)}</td>
      <td>${esc((q.valid_until || "").slice(0, 10) || "—")}</td>
      <td><span class="pill" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent)">${label}</span></td>
      <td class="muted-sm">${esc((q.created_at || "").slice(0, 10))}</td>
      <td><a href="/dashboard/quotes/${esc(q.id)}" class="muted-sm">Ouvrir →</a></td>
    </tr>`;
  }).join("");
  const customerOpts = customers.map((c) => `<option value="${esc(c.id)}">${esc(`${c.first_name} ${c.last_name}`.trim())}${c.email ? ` — ${esc(c.email)}` : ""}</option>`).join("");
  const leadOpts = leads.map((l) => `<option value="${esc(l.id)}">${esc(l.name)} (score ${l.score ?? "—"})</option>`).join("");
  const productOpts = products.map((p) => `<option value="${esc(p.id)}" data-price="${esc(p.discount_price ?? p.price)}" data-name="${esc(p.name)}">${esc(p.name)} — ${esc(p.discount_price ?? p.price)} ${esc(currency)}</option>`).join("");

  const content = `
<style>
  .q-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .q-item-row { display: grid; grid-template-columns: 1fr 80px 120px 90px 34px; gap: 6px; margin-bottom: 6px; }
  .q-item-row input, .q-item-row select { padding: 8px; border-radius: 8px; border: 1px solid var(--border,#e2e8f0); background: var(--card,#fff); color: var(--text,#0f172a); font-size: 13px; }
  @media (max-width: 700px) { .q-item-row { grid-template-columns: 1fr 1fr; } }
</style>
<section class="page-head" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
  <div><h2>Devis</h2><p class="muted">DRAFT → SENT → VIEWED → ACCEPTED / REJECTED / EXPIRED. L'envoi est <b>réal</b> (e-mail ou webchat) ; sans canal, échec honnête. Le client accepte via un lien public, sans compte.</p></div>
  ${canWrite ? `<button class="btn primary" id="q-new-toggle">+ Nouveau devis</button>` : ""}
</section>
${canWrite ? `
<div class="card" id="q-new" style="display:none;margin-bottom:16px">
  <h3 style="margin-top:0">Nouveau devis</h3>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
    <div class="field"><label>Client (optionnel)</label><select id="q-customer"><option value="">—</option>${customerOpts}</select></div>
    <div class="field"><label>Lead (optionnel)</label><select id="q-lead"><option value="">—</option>${leadOpts}</select></div>
    <div class="field"><label>Validité (optionnel)</label><input type="date" id="q-valid"/></div>
  </div>
  <label style="font-size:13px;font-weight:600">Lignes (produits du catalogue — prix non modifiables)</label>
  <div id="q-items"></div>
  <button class="btn ghost" id="q-add-item" type="button">+ Ajouter une ligne</button>
  <div class="field" style="margin-top:10px"><label>Notes (optionnel)</label><textarea id="q-notes" rows="2" style="width:100%"></textarea></div>
  <div style="display:flex;gap:8px;margin-top:10px">
    <button class="btn primary" id="q-create">Créer le brouillon</button>
    <button class="btn ghost" id="q-cancel-new">Annuler</button>
  </div>
</div>` : ""}
<div class="card">
  <table class="tbl">
    <thead><tr><th>N°</th><th>Client</th><th>Lignes</th><th>Total</th><th>Validité</th><th>Statut</th><th>Créé</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="muted">Aucun devis pour le moment.</td></tr>`}</tbody>
  </table>
</div>
${canWrite ? `<script>
(function () {
  "use strict";
  var CSRF = ${JSON.stringify(csrf)};
  var CURRENCY = ${JSON.stringify(currency)};
  var PRODUCT_OPS = ${JSON.stringify(productOpts)};
  var PRODUCTS = {};
  ${products.map((p) => `PRODUCTS[${JSON.stringify(p.id)}] = { name: ${JSON.stringify(p.name)}, price: ${Number(p.discount_price ?? p.price) || 0 };`).join("\n  ")}
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, "X-Requested-With": "fetch" } }, opts || {})).then(function (r) { return r.json(); });
  }
  var box = document.getElementById("q-items");
  function addRow() {
    var d = document.createElement("div");
    d.className = "q-item-row";
    d.innerHTML = '<select class="qi-product">' + ${JSON.stringify(productOpts)} + '<option value="">— Ligne libre (service) —</option></select>' +
      '<input class="qi-qty" type="number" min="1" max="10000" value="1"/>' +
      '<input class="qi-price" type="number" min="0" placeholder="Prix U. (libre)" disabled/>' +
      '<input class="qi-discount" type="number" min="0" placeholder="Remise ligne"/>' +
      '<button class="qi-del" type="button" title="Retirer">✕</button>';
    var sel = d.querySelector(".qi-product"), price = d.querySelector(".qi-price");
    sel.addEventListener("change", function () {
      var p = PRODUCTS[sel.value];
      if (p) { price.value = p.price; price.disabled = true; }
      else { price.value = ""; price.disabled = false; }
    });
    d.querySelector(".qi-del").addEventListener("click", function () { d.remove(); });
    box.appendChild(d);
  }
  addRow();
  document.getElementById("q-add-item").addEventListener("click", addRow);
  document.getElementById("q-new-toggle").addEventListener("click", function () {
    var el = document.getElementById("q-new");
    el.style.display = el.style.display === "none" ? "block" : "none";
  });
  document.getElementById("q-cancel-new").addEventListener("click", function () { document.getElementById("q-new").style.display = "none"; });
  document.getElementById("q-create").addEventListener("click", function () {
    var items = [];
    box.querySelectorAll(".q-item-row").forEach(function (row) {
      var pid = row.querySelector(".qi-product").value;
      var qty = row.querySelector(".qi-qty").value;
      var price = row.querySelector(".qi-price").value;
      var disc = row.querySelector(".qi-discount").value;
      if (pid) items.push({ product_id: pid, quantity: qty });
      else if (price !== "") items.push({ name: "Prestation", unit_price: price, quantity: qty, line_discount: disc });
    });
    if (!items.length) { alert("Ajoutez au moins une ligne valide."); return; }
    var body = { items: items, notes: document.getElementById("q-notes").value || undefined };
    if (document.getElementById("q-customer").value) body.customer_id = document.getElementById("q-customer").value;
    if (document.getElementById("q-lead").value) body.lead_id = document.getElementById("q-lead").value;
    var v = document.getElementById("q-valid").value;
    if (v) body.valid_until = v;
    api("/api/quotes", { method: "POST", body: JSON.stringify(body) }).then(function (j) {
      if (j.error) { alert(j.error); return; }
      location.href = "/dashboard/quotes/" + j.quote.id;
    });
  });
})();
</script>` : ""}`;
  return appLayout({ title: "Devis", user, org, role, path, csrf, content });
}

export function quoteDetailPage({ user, org, role, path, csrf, quote, items, customer, lead, deal, currency }) {
  const canWrite = ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"].includes(role);
  const canDelete = ["OWNER", "ADMIN", "MANAGER"].includes(role);
  const STATUS = { DRAFT: ["#64748b", "Brouillon"], SENT: ["#3b82f6", "Envoyé"], VIEWED: ["#8b5cf6", "Consulté"], ACCEPTED: ["#16a34a", "Accepté"], REJECTED: ["#dc2626", "Refusé"], EXPIRED: ["#f59e0b", "Expiré"], CANCELLED: ["#94a3b8", "Annulé"] };
  const [color, label] = STATUS[quote.status] || STATUS.DRAFT;
  const rows = items.map((it, i) => `
    <tr><td>${i + 1}. ${esc(it.name)}</td><td class="num">${esc(it.quantity)}</td><td class="num">${esc(it.unit_price)} ${esc(currency)}</td><td class="num">${esc(it.total)} ${esc(currency)}</td></tr>`).join("");
  const content = `
<section class="page-head">
  <h2>Devis ${esc(quote.number)}</h2>
  <span class="pill" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent);font-size:13px">${label}</span>
</section>
<div class="card">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:13.5px">
    <div><b>Client</b><br/>${esc(customer ? `${customer.first_name} ${customer.last_name}`.trim() : (lead ? esc(lead.name) : "—"))}</div>
    <div><b>Lead</b><br/>${lead ? esc(lead.name) + " (score " + (lead.score ?? "—") + ")" : "—"}</div>
    <div><b>Deal</b><br/>${deal ? esc(deal.name) + " — " + esc(deal.stage) : "—"}</div>
    <div><b>Validité</b><br/>${esc((quote.valid_until || "").slice(0, 10) || "—")}</div>
  </div>
  <table class="tbl" style="margin-top:14px">
    <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">P.U.</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="margin-top:12px;text-align:right;font-size:14px;max-width:300px;margin-left:auto">
    <div style="display:flex;justify-content:space-between;padding:3px 0">Sous-total <b>${esc(quote.subtotal)} ${esc(currency)}</b></div>
    ${Number(quote.discount) > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0">Remise <b>−${esc(quote.discount)} ${esc(currency)}</b></div>` : ""}
    <div style="display:flex;justify-content:space-between;padding:5px 0;border-top:2px solid var(--text,#0f172a);margin-top:4px;font-size:16px">TOTAL <b>${esc(quote.total)} ${esc(currency)}</b></div>
  </div>
  ${quote.notes ? `<p class="muted-sm" style="margin-top:12px">Notes : ${esc(quote.notes)}</p>` : ""}
  <div class="q-actions">
    ${canWrite && ["DRAFT"].includes(quote.status) ? `<button class="btn primary" data-act="send">📤 Envoyer le devis (réel)</button>` : ""}
    ${canWrite && ["DRAFT", "SENT", "VIEWED"].includes(quote.status) ? `<button class="btn ghost" data-act="cancel">Annuler</button>` : ""}
    ${canDelete && quote.status === "DRAFT" ? `<button class="btn ghost" data-act="delete" data-confirm="Supprimer ce brouillon ?">Supprimer</button>` : ""}
    <a class="btn ghost" href="/api/quotes/${esc(quote.id)}/pdf">⬇️ Télécharger le PDF</a>
    ${["SENT", "VIEWED"].includes(quote.status) ? `<button class="btn ghost" data-act="copy">🔗 Copier le lien client</button>` : ""}
    ${["SENT", "VIEWED"].includes(quote.status) ? `<a class="btn ghost" target="_blank" rel="noopener" href="/quote/${esc(quote.access_token)}">Ouvrir la vue client</a>` : ""}
  </div>
  <p class="muted-sm" id="q-msg" style="margin-top:10px"></p>
</div>
${canWrite ? `<script>
(function () {
  "use strict";
  var CSRF = ${JSON.stringify(csrf)};
  var ID = ${JSON.stringify(quote.id)};
  var LINK = "/quote/" + ${JSON.stringify(quote.access_token)};
  function msg(t, err) { var el = document.getElementById("q-msg"); el.textContent = t; el.style.color = err ? "#dc2626" : "#16a34a"; }
  document.querySelectorAll("[data-act]").forEach(function (b) {
    b.addEventListener("click", function () {
      var act = b.dataset.act;
      if (act === "copy") { navigator.clipboard.writeText(location.origin + LINK).then(function () { msg("Lien client copié."); }); return; }
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      var req = act === "delete"
        ? fetch("/api/quotes/" + ID, { method: "DELETE", headers: { "X-CSRF-Token": CSRF, "X-Requested-With": "fetch" } })
        : fetch("/api/quotes/" + ID + "/" + act, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, "X-Requested-With": "fetch" }, body: JSON.stringify({}) });
      req.then(function (r) { return r.json(); }).then(function (j) {
        if (act === "send") {
          if (j.status === "sent") { msg("Devis envoyé via " + j.channel + "."); location.reload(); }
          else msg(j.message || j.error || "Échec de l'envoi.", true);
        } else if (j.error) { msg(j.error, true); }
        else if (act === "delete") { location.href = "/dashboard/quotes"; }
        else location.reload();
      });
    });
  });
})();
</script>` : ""}`;
  return appLayout({ title: "Devis " + quote.number, user, org, role, path, csrf, content });
}

/* ================= COMMANDES ================= */
export function ordersPage({ user, org, role, path, csrf, orders, providers, currency }) {
  const canWrite = ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"].includes(role);
  const STATUS = { PENDING: ["#64748b", "En attente"], CONFIRMED: ["#3b82f6", "Confirmée"], PAID: ["#8b5cf6", "Payée"], PROCESSING: ["#0ea5e9", "En cours"], COMPLETED: ["#16a34a", "Terminée"], CANCELLED: ["#94a3b8", "Annulée"], REFUNDED: ["#dc2626", "Remboursée"] };
  const ACTIONS = { PENDING: [["confirm", "Confirmer"]], CONFIRMED: [], PAID: [["processing", "Mettre en cours"]], PROCESSING: [["complete", "✔ Terminer"]], COMPLETED: [] };
  const rows = orders.map((o) => {
    const [color, label] = STATUS[o.status] || STATUS.PENDING;
    const acts = (ACTIONS[o.status] || []).map(([a, l]) => `<button class="btn ghost" data-o="${esc(o.id)}" data-a="${a}" style="padding:4px 10px;font-size:12px">${l}</button>`).join(" ");
    return `
    <tr>
      <td><b>${esc(o.number)}</b></td>
      <td>${esc(o.customer_name || "—")}</td>
      <td>${esc(o.quote_number || "—")}</td>
      <td>${esc(o.total)} ${esc(o.currency || currency)}</td>
      <td>${o.has_paid ? "✅ payée" : o.has_payment_pending ? "⏳ paiement en attente" : (canWrite ? `<button class="btn ghost" data-o="${esc(o.id)}" data-a="pay" style="padding:4px 10px;font-size:12px">💳 Paiement</button>` : "—")}</td>
      <td><span class="pill" style="color:${color};background:color-mix(in srgb, ${color} 12%, transparent)">${label}</span></td>
      <td class="muted-sm">${esc((o.created_at || "").slice(0, 10))}</td>
      <td>${acts}</td>
    </tr>`;
  }).join("");
  const provRows = providers.map((p) => `<tr><td>${esc(p.label)}</td><td>${p.status === "CONNECTED" ? '<span class="pill" style="color:#16a34a">CONNECTED</span>' : '<span class="pill" style="color:#f59e0b">CONFIGURATION_REQUIRED</span>'}${p.needs && p.needs.length ? `<div class="muted-sm">${p.needs.map(esc).join("<br/>")}</div>` : ""}</td></tr>`).join("");
  const content = `
<section class="page-head"><h2>Commandes</h2><p class="muted">Une commande naît d'un <b>devis accepté</b>. Elle est <b>payée</b> uniquement après confirmation réelle d'un paiement (fournisseur — jamais simulé en production).</p></section>
<div class="card">
  <table class="tbl">
    <thead><tr><th>N°</th><th>Client</th><th>Devis</th><th>Total</th><th>Paiement</th><th>Statut</th><th>Créée</th><th>Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="muted">Aucune commande. Acceptez un devis puis créez la commande.</td></tr>`}</tbody>
  </table>
</div>
<div class="card" style="margin-top:16px">
  <h3 style="margin-top:0">Fournisseurs de paiement</h3>
  <table class="tbl"><thead><tr><th>Fournisseur</th><th>État (honnête)</th></tr></thead><tbody>${provRows}</tbody></table>
  <p class="muted-sm" id="pay-msg" style="margin-top:10px"></p>
</div>
${canWrite ? `<script>
(function () {
  "use strict";
  var CSRF = ${JSON.stringify(csrf)};
  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, "X-Requested-With": "fetch" } }, opts || {})).then(function (r) { return r.json(); });
  }
  function msg(t, err) { var el = document.getElementById("pay-msg"); el.textContent = t; el.style.color = err ? "#dc2626" : "#16a34a"; }
  document.querySelectorAll("button[data-a]").forEach(function (b) {
    b.addEventListener("click", function () {
      var a = b.dataset.a, o = b.dataset.o;
      if (a === "pay") {
        api("/api/payments/providers").then(function (j) {
          var avail = (j.providers || []).filter(function (p) { return p.status === "CONNECTED" && p.provider !== "TEST"; });
          if (!avail.length) { msg("Aucun fournisseur de paiement CONFIGURÉ — configurez une clé (voir README Phase 7). Aucun paiement simulé.", true); return; }
          var list = avail.map(function (p) { return p.provider + " — " + p.label; }).join("\\n");
          var choice = prompt("Fournisseur de paiement :\\n" + list, avail[0].provider);
          if (!choice) return;
          api("/api/payments", { method: "POST", body: JSON.stringify({ order_id: o, provider: choice }) }).then(function (j2) {
            if (j2.status === "CONFIGURATION_REQUIRED") { msg(j2.message || "Configuration requise.", true); }
            else if (j2.error) { msg(j2.error, true); }
            else { msg("Intention de paiement créée (PENDING) — en attente du fournisseur. " + (j2.instructions || "")); }
          });
        });
        return;
      }
      api("/api/orders/" + o + "/" + a, { method: "POST", body: JSON.stringify({}) }).then(function (j) {
        if (j.error) { msg(j.error, true); location.reload(); }
        else location.reload();
      });
    });
  });
})();
</script>` : ""}`;
  return appLayout({ title: "Commandes", user, org, role, path, csrf, content });
}

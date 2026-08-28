// server/views/crm.js — Phase 2 : pages du moteur commercial
import { esc } from "../security.js";
import { appLayout } from "./app.js";
import { analyzeLead, salesCoachAnalysis } from "../ai/smart.js";

/* ---------- helpers ---------- */
const CURRENCY_LABELS = { XOF: "FCFA", XAF: "FCFA", EUR: "€", USD: "$", GBP: "£", CAD: "$", MAD: "DH", DZD: "DA", TND: "DT", CHF: "CHF" };
export function fmtMoney(value, currency) {
  if (value === null || value === undefined) return "—";
  const sym = CURRENCY_LABELS[String(currency || "").toUpperCase()] || currency || "";
  const n = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Math.round(Number(value) * 100) / 100);
  return `${n} ${sym}`.trim();
}

const LEAD_STATUS_COLORS = {
  NEW: "var(--muted)", CONTACTED: "#0284c7", QUALIFIED: "#7c3aed", HOT: "#ea580c",
  PROPOSAL: "#d97706", NEGOTIATION: "#ca8a04", WON: "#16a34a", LOST: "#dc2626",
};
const LEAD_STATUS_LABELS = { NEW: "Nouveau", CONTACTED: "Contacté", QUALIFIED: "Qualifié", HOT: "Chaud", PROPOSAL: "Proposition", NEGOTIATION: "Négociation", WON: "Gagné", LOST: "Perdu" };
export function leadBadge(status) {
  const c = LEAD_STATUS_COLORS[status] || "var(--muted)";
  return `<span class="badge-l" style="background:color-mix(in srgb, ${c} 14%, transparent); color:${c}">${esc(LEAD_STATUS_LABELS[status] || status)}</span>`;
}
export function temperature(score) {
  const s = Number(score) || 0;
  if (s >= 81) return `<span class="temp t4" title="Très chaud (81-100)">🔥 ${s}</span>`;
  if (s >= 61) return `<span class="temp t3" title="Chaud (61-80)">🌶 ${s}</span>`;
  if (s >= 31) return `<span class="temp t2" title="Tiède (31-60)">🌤 ${s}</span>`;
  return `<span class="temp t1" title="Froid (0-30)">❄ ${s}</span>`;
}
const STOCK_BADGES = {
  IN_STOCK: '<span class="tag ok">En stock</span>',
  LOW_STOCK: '<span class="tag warn">Stock faible</span>',
  OUT_OF_STOCK: '<span class="tag err">Rupture de stock</span>',
};
function stockBadge(p) {
  if (p.type === "SERVICE") return '<span class="tag">Service</span>';
  if (p.stock_quantity <= 0) return STOCK_BADGES.OUT_OF_STOCK;
  if (p.low_stock_threshold > 0 && p.stock_quantity <= p.low_stock_threshold) return STOCK_BADGES.LOW_STOCK;
  return STOCK_BADGES.IN_STOCK;
}
function productStatusBadge(s) {
  return s === "ACTIVE" ? '<span class="tag ok">Actif</span>' : '<span class="tag">Archivé</span>';
}
function dealStageBadge(stage) {
  const map = { NEW: "var(--muted)", QUALIFICATION: "#0284c7", PROPOSAL: "#d97706", NEGOTIATION: "#ca8a04", WON: "#16a34a", LOST: "#dc2626" };
  const c = map[stage] || "var(--muted)";
  return `<span class="badge-l" style="background:color-mix(in srgb, ${c} 14%, transparent); color:${c}">${esc(stage)}</span>`;
}
function paginationHtml(p, basePath) {
  if (p.pages <= 1) return "";
  const qs = (n) => `${basePath}?page=${n}`;
  return `<div class="pagination">
    ${p.page > 1 ? `<a class="btn small ghost" href="${qs(p.page - 1)}">← Précédent</a>` : ""}
    <span class="muted-sm">Page ${p.page} / ${p.pages} — ${p.total} résultat(s)</span>
    ${p.page < p.pages ? `<a class="btn small ghost" href="${qs(p.page + 1)}">Suivant →</a>` : ""}
  </div>`;
}

function crmLayout(ctx, title, content) {
  return appLayout({
    title, user: ctx.user, org: ctx.org, role: ctx.member.role, path: ctx.path, csrf: ctx.csrf, content,
  });
}

const select = (id, name, options, selected, placeholder) => `
  <select id="${id}" name="${name}" class="filter-sel">
    ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}
    ${options.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
  </select>`;

/* ============================ PRODUITS ============================ */
export function productsPage(ctx, { products, pagination, categories, q }) {
  const catOpts = categories.map((c) => ({ value: c.id, label: c.name }));
  return crmLayout(ctx, "Produits & Services", `
  <div class="page-toolbar">
    <h2>Produits & Services</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/api/products/import/template" title="Modèle CSV">⬇ Modèle CSV</a>
      <a class="btn ghost" href="/api/products/export.csv">⬇ Exporter CSV</a>
      <a class="btn primary" href="/dashboard/products/new">+ Ajouter</a>
    </div>
  </div>

  <div class="card filters-card">
    <form method="GET" action="/dashboard/products" class="form-inline filters">
      <input type="search" name="q" value="${esc(q.q || "")}" placeholder="Rechercher (nom, SKU, catégorie, description)…"/>
      ${select("f_status", "status", [
        { value: "ACTIVE", label: "Actif" }, { value: "INACTIVE", label: "Archivé" },
      ], q.status, "Statut")}
      ${select("f_stock", "stock", [
        { value: "IN_STOCK", label: "En stock" }, { value: "LOW_STOCK", label: "Stock faible" }, { value: "OUT_OF_STOCK", label: "Rupture" },
      ], q.stock, "Stock")}
      ${select("f_cat", "category_id", catOpts, q.category_id, "Catégorie")}
      <input type="number" name="price_min" value="${esc(q.price_min || "")}" placeholder="Prix min" class="narrow"/>
      <input type="number" name="price_max" value="${esc(q.price_max || "")}" placeholder="Prix max" class="narrow"/>
      ${select("f_sort", "sort", [
        { value: "created", label: "Plus récents" }, { value: "name", label: "Nom" },
        { value: "price", label: "Prix" }, { value: "stock", label: "Stock" },
      ], q.sort, "Trier par")}
      ${select("f_dir", "dir", [{ value: "DESC", label: "↓ Décroissant" }, { value: "ASC", label: "↑ Croissant" }], q.dir, "")}
      <button type="submit" class="btn ghost">Filtrer</button>
      ${q.q || q.status || q.stock || q.category_id || q.price_min || q.price_max ? '<a class="btn ghost" href="/dashboard/products">✕ Réinitialiser</a>' : ""}
    </form>
  </div>

  ${products.length ? `
  <div class="card table-card">
    <div class="table-wrap">
    <table class="table">
      <thead><tr><th>Produit</th><th>Catégorie</th><th>Prix</th><th>Stock</th><th>Statut</th><th class="right"></th></tr></thead>
      <tbody>
      ${products.map((p) => `<tr>
        <td class="strong"><a href="/dashboard/products/${p.id}" class="row-link">${esc(p.name)}</a>
          <div class="muted-sm">${esc(p.sku || "—")} · ${p.type === "SERVICE" ? "Service" : "Produit"}</div></td>
        <td>${esc(p.category_name || "—")}</td>
        <td>${p.discount_price !== null ? `<s class="muted-sm">${esc(fmtMoney(p.price, p.currency || ctx.org.currency))}</s> <b>${esc(fmtMoney(p.discount_price, p.currency || ctx.org.currency))}</b>` : esc(fmtMoney(p.price, p.currency || ctx.org.currency))}</td>
        <td>${stockBadge(p)}${p.type !== "SERVICE" ? ` <span class="muted-sm">${p.stock_quantity}</span>` : ""}</td>
        <td>${productStatusBadge(p.status)}</td>
        <td class="right"><a class="btn small ghost" href="/dashboard/products/${p.id}">Voir</a></td>
      </tr>`).join("")}
      </tbody>
    </table>
    </div>
    ${paginationHtml(pagination, "/dashboard/products" + (q.q ? `?q=${encodeURIComponent(q.q)}` : ""))}
  </div>` : `
  <div class="card empty-state">
    <span class="empty-ico">📦</span>
    <h3>Aucun produit pour le moment.</h3>
    <p class="muted">Ajoutez votre premier produit ou importez votre catalogue depuis un CSV.</p>
    <div class="empty-actions">
      <a class="btn primary" href="/dashboard/products/new">+ Ajouter un produit</a>
      <a class="btn ghost" href="/dashboard/products#import">Importer un CSV</a>
    </div>
  </div>`}

  <div class="card" id="import">
    <div class="card-head"><h3>Importer des produits (CSV)</h3><span class="muted-sm">Colonnes : name, sku, description, category, price, currency, stock, status</span></div>
    <form data-csv-import class="form" id="csvForm">
      <input type="file" id="csvFile" accept=".csv,text/csv" />
      <textarea id="csvText" rows="6" placeholder="…ou collez ici le contenu de votre CSV" spellcheck="false"></textarea>
      <div class="form-row">
        <span class="muted-sm">Aperçu avant import : erreurs ligne par ligne, doublons SKU, prix et stock invalides.</span>
        <button type="submit" class="btn primary">Aperçu de l'import</button>
      </div>
    </form>
    <div id="csvPreview" class="csv-preview hidden">
      <h4 id="csvSummary"></h4>
      <div class="table-wrap"><table class="table csv-table" id="csvTable"></table></div>
      <div class="form-row">
        <span class="muted-sm">Seules les lignes valides seront importées.</span>
        <button class="btn primary" data-csv-confirm>Importer les lignes valides</button>
      </div>
    </div>
  </div>
  `);
}

export function productFormPage(ctx, { product, categories }) {
  const p = product || { name: "", sku: "", type: "PRODUCT", category_id: "", description: "", price: "", discount_price: "", currency: ctx.org.currency, stock_quantity: 0, low_stock_threshold: 0, status: "ACTIVE" };
  return crmLayout(ctx, product ? "Modifier le produit" : "Nouveau produit", `
  <div class="page-toolbar"><h2>${product ? "Modifier le produit" : "Nouveau produit"}</h2>
    <a class="btn ghost" href="/dashboard/products">← Retour</a></div>
  <form method="POST" action="/api/products" ${product ? `data-method="PUT" data-id="${p.id}"` : ""} data-product-form class="form card form-card" novalidate>
    <div class="field-2col">
      <div class="field"><label for="name">Nom *</label><input id="name" name="name" value="${esc(p.name)}" required maxlength="120"/></div>
      <div class="field"><label for="sku">SKU</label><input id="sku" name="sku" value="${esc(p.sku || "")}" placeholder="IPHONE15-128" maxlength="40"/></div>
    </div>
    <div class="field-3col">
      <div class="field"><label for="type">Type</label><select id="type" name="type">
        <option value="PRODUCT"${p.type === "PRODUCT" ? " selected" : ""}>Produit</option>
        <option value="SERVICE"${p.type === "SERVICE" ? " selected" : ""}>Service</option></select></div>
      <div class="field"><label for="category_id">Catégorie</label><select id="category_id" name="category_id">
        <option value="">— Aucune —</option>
        ${categories.map((c) => `<option value="${c.id}"${p.category_id === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select></div>
      <div class="field"><label for="status">Statut</label><select id="status" name="status">
        <option value="ACTIVE"${p.status === "ACTIVE" ? " selected" : ""}>Actif</option>
        <option value="INACTIVE"${p.status === "INACTIVE" ? " selected" : ""}>Archivé</option></select></div>
    </div>
    <div class="field"><label for="description">Description</label><textarea id="description" name="description" rows="4" maxlength="2000">${esc(p.description || "")}</textarea></div>
    <div class="field-3col">
      <div class="field"><label for="price">Prix *</label><input id="price" name="price" type="number" min="0" step="0.01" value="${esc(p.price)}" required/></div>
      <div class="field"><label for="discount_price">Prix promotionnel</label><input id="discount_price" name="discount_price" type="number" min="0" step="0.01" value="${esc(p.discount_price ?? "")}" placeholder="Optionnel"/></div>
      <div class="field"><label for="currency">Devise</label><input id="currency" name="currency" value="${esc(p.currency || ctx.org.currency)}" maxlength="3" placeholder="${esc(ctx.org.currency)}"/></div>
    </div>
    <div class="field-2col">
      <div class="field"><label for="stock_quantity">Stock</label><input id="stock_quantity" name="stock_quantity" type="number" min="0" value="${esc(p.stock_quantity)}"/></div>
      <div class="field"><label for="low_stock_threshold">Seuil stock faible</label><input id="low_stock_threshold" name="low_stock_threshold" type="number" min="0" value="${esc(p.low_stock_threshold)}"/></div>
    </div>

    <h3 class="subhead">Variantes <span class="muted-sm">(tailles, capacités…)</span></h3>
    <div id="variantsList" data-variants>
      ${(product ? [] : []).map(() => "")}
    </div>
    <button type="button" class="btn small ghost" data-add-variant>+ Ajouter une variante</button>
    <template data-variant-template>
      <div class="variant-row">
        <input name="v_name" placeholder="Nom (S, M, L…)" required/>
        <input name="v_sku" placeholder="SKU variante"/>
        <input name="v_price" type="number" min="0" step="0.01" placeholder="Prix (défaut: prix produit)"/>
        <input name="v_stock" type="number" min="0" placeholder="Stock"/>
        <input name="v_threshold" type="number" min="0" placeholder="Seuil"/>
        <button type="button" class="icon-btn variant-remove" title="Retirer">✕</button>
      </div>
    </template>

    <h3 class="subhead">Images <span class="muted-sm">(URLs — première image = principale)</span></h3>
    <div id="imagesList" data-images></div>
    <button type="button" class="btn small ghost" data-add-image>+ Ajouter une image</button>
    <template data-image-template>
      <div class="image-row">
        <input name="i_url" type="url" placeholder="https://…/image.jpg" required/>
        <input name="i_alt" placeholder="Alt text"/>
        <button type="button" class="icon-btn image-remove" title="Retirer">✕</button>
      </div>
    </template>

    <div class="form-row"><button type="submit" class="btn primary">${product ? "Enregistrer" : "Créer le produit"}</button></div>
  </form>
  ${product ? JSON.stringify({ initialVariants: product._variants || [], initialImages: product._images || [] }) && `<script type="application/json" id="productInit">${esc(JSON.stringify({ variants: product._variants || [], images: product._images || [] }))}</script>` : ""}
  `);
}

export function productDetailPage(ctx, { product: p, variants, images, sales }) {
  return crmLayout(ctx, p.name, `
  <div class="page-toolbar">
    <h2>${esc(p.name)}</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/dashboard/products/${p.id}/edit">Modifier</a>
      <button class="btn ghost" data-fetch-action="/api/products/${p.id}/duplicate" data-method="POST">Dupliquer</button>
      <button class="btn ghost" data-fetch-action="/api/products/${p.id}/archive" data-method="POST">${p.status === "ACTIVE" ? "Archiver" : "Réactiver"}</button>
      <button class="btn danger" data-confirm="Supprimer ce produit définitivement ?" data-fetch-action="/api/products/${p.id}" data-method="DELETE">Supprimer</button>
      <a class="btn ghost" href="/dashboard/products">← Retour</a>
    </div>
  </div>

  <div class="product-detail-grid">
    <div class="card">
      ${images.length ? `
      <div class="gallery">
        <a class="gallery-main" href="${esc(images[0].url)}" target="_blank" rel="noopener"><img src="${esc(images[0].url)}" alt="${esc(images[0].alt_text || p.name)}" loading="lazy" onerror="this.parentNode.style.display='none'"/></a>
        ${images.length > 1 ? `<div class="gallery-thumbs">${images.slice(1).map((im) => `<a href="${esc(im.url)}" target="_blank" rel="noopener"><img src="${esc(im.url)}" alt="${esc(im.alt_text || "")}" loading="lazy" onerror="this.style.display='none'"/></a>`).join("")}</div>` : ""}
      </div>` : `<div class="no-image">📷<br/>Aucune image</div>`}
      <div class="detail-actions" style="padding:12px 16px">
        <button class="btn small ghost" data-add-image-form>➕ Ajouter une image</button>
        ${images.map((im) => `<button class="btn small ghost" data-confirm="Supprimer cette image ?" data-fetch-action="/api/images/${im.id}" data-method="DELETE" title="${esc(im.url)}" style="margin:2px">✕ ${esc((im.alt_text || im.url).slice(0, 18))}</button>`).join("")}
        <form data-image-form class="form-inline hidden" style="padding:12px 16px;border-top:1px solid var(--border)">
          <input type="url" name="url" placeholder="https://…" required/>
          <input type="text" name="alt_text" placeholder="Alt"/>
          <button class="btn small primary" data-fetch-action="/api/products/${p.id}/images" data-method="POST">OK</button>
        </form>
      </div>
    </div>

    <div class="card form-card" style="align-self:start">
      <div class="detail-lines">
        <div class="ob-line"><span>SKU</span><b>${esc(p.sku || "—")}</b></div>
        <div class="ob-line"><span>Type</span><b>${p.type === "SERVICE" ? "Service" : "Produit"}</b></div>
        <div class="ob-line"><span>Catégorie</span><b>${esc(p.category_name || "—")}</b></div>
        <div class="ob-line"><span>Prix</span><b>${esc(fmtMoney(p.price, p.currency || ctx.org.currency))}${p.discount_price !== null ? ` → <span style="color:var(--success)">${esc(fmtMoney(p.discount_price, p.currency || ctx.org.currency))}</span>` : ""}</b></div>
        <div class="ob-line"><span>Stock</span><b>${p.type === "SERVICE" ? "—" : `${p.stock_quantity} (seuil ${p.low_stock_threshold})`} ${stockBadge(p)}</b></div>
        <div class="ob-line"><span>Statut</span><b>${productStatusBadge(p.status)}</b></div>
      </div>
      ${p.description ? `<p class="muted" style="white-space:pre-wrap">${esc(p.description)}</p>` : ""}
    </div>
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Variantes</h3></div>
    ${variants.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Nom</th><th>SKU</th><th>Prix</th><th>Stock</th><th class="right"></th></tr></thead>
      <tbody>${variants.map((v) => `<tr>
        <td class="strong">${esc(v.name)}</td><td>${esc(v.sku || "—")}</td>
        <td>${v.price !== null ? esc(fmtMoney(v.price, p.currency || ctx.org.currency)) : "—"}</td>
        <td>${stockBadge(v)} <span class="muted-sm">${v.stock_quantity}</span></td>
        <td class="right"><button class="btn small danger" data-confirm="Supprimer cette variante ?" data-fetch-action="/api/variants/${v.id}" data-method="DELETE">Supprimer</button></td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<p class="muted">Aucune variante.</p>`}
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Performances commerciales</h3><span class="muted-sm">Ventes réalisées (deals gagnés)</span></div>
    ${sales.quantity > 0 || sales.revenue > 0 ? `<div class="detail-lines">
      <div class="ob-line"><span>Unités vendues</span><b>${new Intl.NumberFormat("fr-FR").format(sales.quantity)}</b></div>
      <div class="ob-line"><span>Chiffre d'affaires</span><b>${esc(fmtMoney(sales.revenue, p.currency || ctx.org.currency))}</b></div>
    </div>` : `<p class="muted">Aucune vente enregistrée pour ce produit pour le moment.</p>`}
  </div>
  `);
}

export function categoriesPage(ctx, { categories, counts }) {
  return crmLayout(ctx, "Catégories", `
  <div class="page-toolbar"><h2>Catégories</h2><a class="btn ghost" href="/dashboard/products">← Produits</a></div>
  <div class="card form-card">
    <div class="card-head"><h3>Nouvelle catégorie</h3></div>
    <form method="POST" action="/api/categories" data-fetch class="form-inline">
      <input type="text" name="name" placeholder="Nom (ex. Smartphones)" required maxlength="60"/>
      <input type="text" name="description" placeholder="Description (optionnel)" maxlength="300"/>
      <button type="submit" class="btn primary">Créer</button>
    </form>
  </div>
  <div class="card table-card">
    ${categories.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Nom</th><th>Description</th><th>Produits</th><th class="right">Actions</th></tr></thead>
      <tbody>${categories.map((c) => `<tr>
        <td class="strong">${esc(c.name)}</td><td class="muted-sm">${esc(c.description || "—")}</td>
        <td>${counts[c.id] || 0}</td>
        <td class="right">
          <button class="btn small ghost" data-edit-cat data-name="${esc(c.name)}">Modifier</button>
          <button class="btn small danger" data-confirm="Supprimer cette catégorie ? (les produits sont conservés)" data-fetch-action="/api/categories/${c.id}" data-method="DELETE">Supprimer</button>
        </td>
      </tr>
      <tr class="edit-row hidden" data-edit-row="${c.id}">
        <td colspan="4"><form method="PUT" action="/api/categories/${c.id}" data-fetch class="form-inline">
          <input type="text" name="name" value="${esc(c.name)}" required maxlength="60"/>
          <input type="text" name="description" value="${esc(c.description || "")}" maxlength="300"/>
          <button class="btn small primary">Enregistrer</button>
        </form></td>
      </tr>`).join("")}</tbody>
    </table></div>` : `<p class="muted" style="padding:12px">Aucune catégorie. Créez-en une ci-dessus (Smartphones, Accessoires, Services…).</p>`}
  </div>
  `);
}

/* ============================ CLIENTS ============================ */
export function customersPage(ctx, { customers, pagination, q }) {
  return crmLayout(ctx, "Contacts", `
  <div class="page-toolbar"><h2>Contacts</h2>
    <a class="btn primary" href="/dashboard/contacts/new">+ Nouveau client</a></div>
  <div class="card filters-card">
    <form method="GET" action="/dashboard/contacts" class="form-inline filters">
      <input type="search" name="q" value="${esc(q.q || "")}" placeholder="Rechercher (nom, e-mail, entreprise, téléphone)…"/>
      ${select("f_status", "status", [{ value: "ACTIVE", label: "Actif" }, { value: "INACTIVE", label: "Inactif" }], q.status, "Statut")}
      <button type="submit" class="btn ghost">Filtrer</button>
    </form>
  </div>
  ${customers.length ? `<div class="card table-card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Nom</th><th>Contact</th><th>Entreprise</th><th>Pays</th><th>Statut</th><th class="right"></th></tr></thead>
    <tbody>${customers.map((c) => `<tr>
      <td class="strong"><a class="row-link" href="/dashboard/contacts/${c.id}">${esc(c.first_name)} ${esc(c.last_name)}</a></td>
      <td class="muted-sm">${esc(c.email || "")}${c.phone ? `<br/>${esc(c.phone)}` : ""}</td>
      <td>${esc(c.company_name || "—")}</td><td>${esc(c.country || "—")}</td>
      <td>${c.status === "ACTIVE" ? '<span class="tag ok">Actif</span>' : '<span class="tag">Inactif</span>'}</td>
      <td class="right"><a class="btn small ghost" href="/dashboard/contacts/${c.id}">Voir</a></td>
    </tr>`).join("")}</tbody>
  </table></div>
  ${paginationHtml(pagination, "/dashboard/contacts" + (q.q ? `?q=${encodeURIComponent(q.q)}` : ""))}</div>` : `
  <div class="card empty-state"><span class="empty-ico">👥</span>
    <h3>Aucun client pour le moment.</h3>
    <div class="empty-actions"><a class="btn primary" href="/dashboard/contacts/new">+ Ajouter un client</a></div>
  </div>`}
  `);
}

export function customerFormPage(ctx, { customer }) {
  const c = customer || { first_name: "", last_name: "", email: "", phone: "", company_name: "", country: "Togo", city: "", notes: "", source: "MANUAL", status: "ACTIVE" };
  return crmLayout(ctx, customer ? "Modifier le client" : "Nouveau client", `
  <div class="page-toolbar"><h2>${customer ? "Modifier le client" : "Nouveau client"}</h2><a class="btn ghost" href="/dashboard/contacts">← Retour</a></div>
  <form method="POST" action="/api/customers" ${customer ? `data-method="PUT" data-id="${c.id}"` : ""} data-fetch class="form card form-card" novalidate>
    <div class="field-2col">
      <div class="field"><label for="first_name">Prénom *</label><input id="first_name" name="first_name" value="${esc(c.first_name)}" required maxlength="50"/></div>
      <div class="field"><label for="last_name">Nom *</label><input id="last_name" name="last_name" value="${esc(c.last_name)}" required maxlength="50"/></div>
    </div>
    <div class="field-2col">
      <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" value="${esc(c.email || "")}"/></div>
      <div class="field"><label for="phone">Téléphone</label><input id="phone" name="phone" type="tel" value="${esc(c.phone || "")}"/></div>
    </div>
    <div class="field-2col">
      <div class="field"><label for="company_name">Entreprise</label><input id="company_name" name="company_name" value="${esc(c.company_name || "")}"/></div>
      <div class="field"><label for="country">Pays</label><input id="country" name="country" value="${esc(c.country || "")}"/></div>
    </div>
    <div class="field-2col">
      <div class="field"><label for="city">Ville</label><input id="city" name="city" value="${esc(c.city || "")}"/></div>
      <div class="field"><label for="source">Source</label><select id="source" name="source">
        ${["MANUAL", "REFERRAL", "WEBSITE", "WHATSAPP", "EMAIL", "FACEBOOK", "INSTAGRAM", "OTHER"].map((s) => `<option${c.source === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes" rows="3">${esc(c.notes || "")}</textarea></div>
    <div class="form-row"><button type="submit" class="btn primary">${customer ? "Enregistrer" : "Créer le client"}</button></div>
  </form>`);
}

export function customerDetailPage(ctx, { customer: c, leads, deals, activities, notes, tasks, conversations }) {
  return crmLayout(ctx, `${c.first_name} ${c.last_name}`, `
  <div class="page-toolbar"><h2>${esc(c.first_name)} ${esc(c.last_name)}</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/dashboard/contacts/${c.id}/edit">Modifier</a>
      <a class="btn ghost" href="/dashboard/contacts">← Retour</a>
    </div></div>
  <div class="detail-lines card form-card">
    <div class="ob-line"><span>Téléphone</span><b>${esc(c.phone || "—")}</b></div>
    <div class="ob-line"><span>E-mail</span><b>${esc(c.email || "—")}</b></div>
    <div class="ob-line"><span>Entreprise</span><b>${esc(c.company_name || "—")}</b></div>
    <div class="ob-line"><span>Pays / Ville</span><b>${esc(c.country || "—")} ${c.city ? "· " + esc(c.city) : ""}</b></div>
    <div class="ob-line"><span>Source</span><b>${esc(c.source)}</b></div>
    <div class="ob-line"><span>Statut</span><b>${c.status === "ACTIVE" ? '<span class="tag ok">Actif</span>' : '<span class="tag">Inactif</span>'}</b></div>
  </div>

  <div class="two-col">
    <div class="card form-card">
      <div class="card-head"><h3>Leads</h3><a class="btn small ghost" href="/dashboard/leads/new?customer_id=${c.id}">+ Lead</a></div>
      ${leads.length ? leads.map((l) => `<a class="list-line" href="/dashboard/leads/${l.id}">${esc(l.name)} ${leadBadge(l.status)} ${temperature(l.score)}</a>`).join("") : '<p class="muted">Aucun lead lié.</p>'}
    </div>
    <div class="card form-card">
      <div class="card-head"><h3>Opportunités</h3><a class="btn small ghost" href="/dashboard/deals/new?customer_id=${c.id}">+ Deal</a></div>
      ${deals.length ? deals.map((d) => `<a class="list-line" href="/dashboard/deals/${d.id}">${esc(d.name)} ${dealStageBadge(d.stage)} <span class="muted-sm">${esc(fmtMoney(d.value, d.currency || ctx.org.currency))}</span></a>`).join("") : '<p class="muted">Aucune opportunité.</p>'}
    </div>
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Tâches</h3><a class="btn small ghost" href="/dashboard/tasks/new?customer_id=${c.id}">+ Tâche</a></div>
    ${tasks.length ? tasks.map((t) => `<div class="list-line">${t.status === "COMPLETED" ? "✅" : t.status === "IN_PROGRESS" ? "🔄" : "⬜"} ${esc(t.title)} <span class="muted-sm">${t.due_date ? "échéance " + esc(t.due_date) : ""} · ${esc(t.priority)}</span></div>`).join("") : '<p class="muted">Aucune tâche.</p>'}
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Notes</h3></div>
    <form method="POST" action="/api/notes" data-fetch data-note-form data-customer="${c.id}" class="form-inline">
      <input type="text" name="content" placeholder="Nouvelle note…" required maxlength="5000"/>
      <button class="btn primary small">Ajouter</button>
    </form>
    ${notes.length ? notes.map((n) => `<div class="note-block">${esc(n.content)}
      <div class="note-meta muted-sm">${esc(n.user_name || "")} · ${esc(new Date(n.created_at).toLocaleDateString("fr-FR"))}
      <button class="btn small ghost" data-edit-note data-note-id="${n.id}" data-content="${esc(n.content)}">Modifier</button>
      <button class="btn small danger" data-confirm="Supprimer cette note ?" data-fetch-action="/api/notes/${n.id}" data-method="DELETE">Supprimer</button></div></div>`).join("") : '<p class="muted">Aucune note.</p>'}
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Conversations IA</h3><span class="muted-sm">Phase 3</span></div>
    ${conversations.length ? "" : '<p class="muted">Les conversations IA de ce client apparaîtront ici (disponible dans une prochaine phase).</p>'}
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Historique des interactions</h3></div>
    ${activities.length ? `<div class="timeline">${activities.map((a) => `<div class="timeline-item">
      <span class="timeline-dot"></span>
      <div><b>${esc(activityLabel(a.type))}</b> ${a.description ? `— ${esc(a.description)}` : ""}
      <div class="muted-sm">${esc(a.user_name || "")} · ${esc(new Date(a.created_at).toLocaleString("fr-FR"))}</div></div>
    </div>`).join("")}</div>` : '<p class="muted">Aucune activité enregistrée.</p>'}
  </div>`);
}

function activityLabel(t) {
  return { CALL: "📞 Appel", EMAIL: "✉️ E-mail", MESSAGE: "💬 Message", MEETING: "🤝 Réunion", NOTE: "📝 Note", STATUS_CHANGE: "🔁 Changement de statut", FOLLOW_UP: "⏰ Suivi", PURCHASE: "🛒 Achat" }[t] || t;
}

/* ============================ LEADS ============================ */
function intentBadge(intent) {
  if (!intent) return '<span class="muted-sm">—</span>';
  const map = { VERY_HIGH: ["#16a34a", "Très haute"], HIGH: ["#16a34a", "Haute"], MEDIUM: ["#d97706", "Moyenne"], LOW: ["#64748b", "Basse"], VERY_LOW: ["#94a3b8", "Très basse"] };
  const [c, label] = map[intent] || ["var(--muted)", intent];
  return `<span class="badge-l" style="background:color-mix(in srgb, ${c} 14%, transparent); color:${c}">${label}</span>`;
}
function priorityBadge(p) {
  if (!p) return '<span class="muted-sm">—</span>';
  const map = { URGENT: "#dc2626", HIGH: "#ea580c", MEDIUM: "#d97706", LOW: "#94a3b8" };
  return `<span class="badge-l" style="background:color-mix(in srgb, ${map[p] || "#94a3b8"} 14%, transparent); color:${map[p] || "#94a3b8"}">${esc(p)}</span>`;
}
function healthBadge(h) {
  const map = { Healthy: "#16a34a", "At Risk": "#d97706", Stalled: "#64748b", Won: "#16a34a", Lost: "#dc2626" };
  return `<span class="badge-l" style="background:color-mix(in srgb, ${map[h] || "#64748b"} 14%, transparent); color:${map[h] || "#64748b"}">${esc(h || "—")}</span>`;
}
function riskBadge(r) {
  const map = { HIGH: "#dc2626", MEDIUM: "#d97706", LOW: "#16a34a" };
  return `<span class="badge-l" style="background:color-mix(in srgb, ${map[r] || "#64748b"} 14%, transparent); color:${map[r] || "#64748b"}">${esc(r || "—")}</span>`;
}
function bantBadge(level) {
  const map = { CONFIRMED: "#16a34a", HIGH: "#16a34a", MEDIUM: "#d97706", LOW: "#94a3b8", UNKNOWN: "#cbd5e1" };
  return `<span class="badge-l" style="background:color-mix(in srgb, ${map[level] || "#cbd5e1"} 14%, transparent); color:${map[level] || "#94a3b8"}">${esc(level || "UNKNOWN")}</span>`;
}
const SMART_FILTER_CHIPS = [
  ["hot", "🔥 Chauds"], ["high_intent", "⚡ Forte intention"], ["high_value", "💎 High value"],
  ["at_risk", "⚠️ À risque"], ["ready_to_buy", "🛒 Prêts à acheter"], ["new", "🆕 Nouveaux (7j)"],
  ["no_followup", "⏰ Sans suivi"], ["no_response", "📴 Sans réponse (3j)"],
];

export function leadsPage(ctx, { leads, pagination, q, members }) {
  const assignOpts = [{ value: "none", label: "Non assigné" }, { value: "me", label: "Moi" }, ...members.map((m) => ({ value: m.user_id, label: `${m.first_name} ${m.last_name}` }))];
  const sortOpts = [
    { value: "date", label: "Date" }, { value: "score", label: "Score" },
    { value: "priority", label: "Priorité" }, { value: "deal_value", label: "Valeur deal" },
  ];
  return crmLayout(ctx, "Leads", `
  <div class="page-toolbar"><h2>Leads</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/dashboard/leads/kanban">☰ Vue pipeline</a>
      <a class="btn primary" href="/dashboard/leads/new">+ Nouveau lead</a>
    </div></div>
  <div class="smart-chips">
    ${SMART_FILTER_CHIPS.map(([f, label]) => `<a class="chip-f${q.filter === f ? " active" : ""}" href="/dashboard/leads?filter=${f}">${label}</a>`).join("")}
    ${q.filter ? `<a class="chip-f" href="/dashboard/leads">✕ Réinitialiser</a>` : ""}
  </div>
  <div class="card filters-card">
    <form method="GET" action="/dashboard/leads" class="form-inline filters">
      ${q.filter ? `<input type="hidden" name="filter" value="${esc(q.filter)}"/>` : ""}
      <input type="search" name="q" value="${esc(q.q || "")}" placeholder="Rechercher…"/>
      ${select("f_status", "status", Object.keys(LEAD_STATUS_LABELS).map((s) => ({ value: s, label: LEAD_STATUS_LABELS[s] })), q.status, "Statut")}
      ${select("f_source", "source", ["WEBSITE", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "EMAIL", "REFERRAL", "MANUAL", "ADVERTISEMENT", "OTHER"].map((s) => ({ value: s, label: s })), q.source, "Source")}
      ${select("f_assign", "assigned_to", assignOpts, q.assigned_to, "Responsable")}
      <input type="number" name="min_score" value="${esc(q.min_score || "")}" placeholder="Score min" class="narrow" min="0" max="100"/>
      ${select("f_sort", "sort", sortOpts, q.sort, "Trier par")}
      <button type="submit" class="btn ghost">Filtrer</button>
    </form>
  </div>
  ${leads.length ? `<div class="card table-card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Lead</th><th>Score</th><th>Intention</th><th>Priorité</th><th>Budget</th><th>Deal</th><th>Statut</th><th>Responsable</th><th class="right">Action</th></tr></thead>
    <tbody>${leads.map((l) => `<tr>
      <td class="strong"><a class="row-link" href="/dashboard/leads/${l.id}">${l.at_risk ? "⚠️ " : ""}${esc(l.name)}</a>
        ${l.company_name ? `<div class="muted-sm">${esc(l.company_name)}</div>` : ""}</td>
      <td>${temperature(l.score)}${l.hot ? " <span title='Hot lead'>🔥</span>" : ""}</td>
      <td>${intentBadge(l.purchase_intent)}</td>
      <td>${priorityBadge(l.priority)}</td>
      <td>${l.budget !== null ? esc(fmtMoney(l.budget, l.currency || ctx.org.currency)) : "—"}</td>
      <td>${l.deal_value !== null && l.deal_value !== undefined ? esc(fmtMoney(l.deal_value, l.currency || ctx.org.currency)) : (l.estimated_value ? `<span class="muted-sm">${esc(fmtMoney(l.estimated_value, l.currency || ctx.org.currency))} <span title="Estimation">(est.)</span></span>` : "—")}</td>
      <td>${leadBadge(l.status)}</td>
      <td>${esc(l.assigned_to_name || "—")}</td>
      <td class="right"><a class="btn small ghost" href="/dashboard/leads/${l.id}">Voir</a></td>
    </tr>`).join("")}</tbody>
  </table></div>
  ${paginationHtml(pagination, "/dashboard/leads" + (q.q ? `?q=${encodeURIComponent(q.q)}` : "") + (q.filter ? `&filter=${encodeURIComponent(q.filter)}` : ""))}</div>` : `
  <div class="card empty-state"><span class="empty-ico">🎯</span>
    <h3>Aucun lead pour le moment.</h3>
    <div class="empty-actions">
      <a class="btn primary" href="/dashboard/leads/new">+ Ajouter un lead</a>
      <a class="btn ghost" href="/dashboard/leads/kanban">Voir le pipeline</a>
    </div>
  </div>`}
  `);
}

export function leadFormPage(ctx, { lead, customers, members }) {
  const l = lead || { name: "", company_name: "", email: "", phone: "", source: "MANUAL", interest: "", budget: "", score: 0, notes: "", next_followup_at: "" };
  const assignOpts = members.map((m) => `<option value="${m.user_id}">${esc(m.first_name)} ${esc(m.last_name)} (${esc(m.role)})</option>`).join("");
  return crmLayout(ctx, lead ? "Modifier le lead" : "Nouveau lead", `
  <div class="page-toolbar"><h2>${lead ? "Modifier le lead" : "Nouveau lead"}</h2><a class="btn ghost" href="/dashboard/leads">← Retour</a></div>
  <form method="POST" action="/api/leads" ${lead ? `data-method="PUT" data-id="${l.id}"` : ""} data-fetch class="form card form-card" novalidate>
    <div class="field-2col">
      <div class="field"><label for="name">Nom / Entreprise *</label><input id="name" name="name" value="${esc(l.name)}" required maxlength="120"/></div>
      <div class="field"><label for="company_name">Société</label><input id="company_name" name="company_name" value="${esc(l.company_name || "")}"/></div>
    </div>
    <div class="field-2col">
      <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" value="${esc(l.email || "")}"/></div>
      <div class="field"><label for="phone">Téléphone</label><input id="phone" name="phone" type="tel" value="${esc(l.phone || "")}"/></div>
    </div>
    <div class="field-3col">
      <div class="field"><label for="source">Source</label><select id="source" name="source">
        ${["WEBSITE", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "EMAIL", "REFERRAL", "MANUAL", "ADVERTISEMENT", "OTHER"].map((s) => `<option${l.source === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label for="budget">Budget</label><input id="budget" name="budget" type="number" min="0" value="${esc(l.budget ?? "")}"/></div>
      <div class="field"><label for="score">Score (0-100)</label><input id="score" name="score" type="number" min="0" max="100" value="${esc(l.score)}"/>
        <span class="field-hint">0-30 Froid · 31-60 Tiède · 61-80 Chaud · 81-100 Très chaud</span></div>
    </div>
    <div class="field"><label for="interest">Intérêt / besoin</label><input id="interest" name="interest" value="${esc(l.interest || "")}" maxlength="300"/></div>
    <div class="field"><label for="notes">Notes</label><textarea id="notes" name="notes" rows="3">${esc(l.notes || "")}</textarea></div>
    <div class="field-2col">
      <div class="field"><label for="next_followup_at">Prochain suivi</label><input id="next_followup_at" name="next_followup_at" type="date" value="${l.next_followup_at ? esc(String(l.next_followup_at).slice(0, 10)) : ""}"/></div>
      ${lead ? `<div class="field"><label for="assigned_to">Responsable</label><select id="assigned_to" name="assigned_to"><option value="">— Non assigné —</option>
        ${assignOpts.replace(`value="${l.assigned_to}"`, `value="${l.assigned_to}" selected`)}</select></div>` : ""}
    </div>
    <div class="form-row"><button type="submit" class="btn primary">${lead ? "Enregistrer" : "Créer le lead"}</button></div>
  </form>`);
}

export function leadDetailPage(ctx, { lead: l, activities, notes, tasks, deals, customer, members }) {
  const db = ctx.db;
  const orgId = ctx.org.id;
  const assignOpts = members.map((m) => `<option value="${m.user_id}"${l.assigned_to === m.user_id ? " selected" : ""}>${esc(m.first_name)} ${esc(m.last_name)}</option>`).join("");

  // ---- Analyse Smart Sales Engine (lecture seule) ----
  const conv = db.prepare("SELECT * FROM conversations WHERE lead_id = ? AND organization_id = ? ORDER BY updated_at DESC LIMIT 1").get(l.id, orgId);
  const messages = conv ? db.prepare("SELECT role, content, metadata, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200").all(conv.id) : [];
  const deal = deals[0] || null;
  let product = null;
  if (deal) {
    const line = db.prepare("SELECT p.* FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ? AND p.organization_id = ? ORDER BY dp.total DESC LIMIT 1").get(deal.id, orgId);
    if (line) product = line;
  }
  if (!product && l.interest && l.interest.length >= 3) {
    const like = `%${l.interest.toLowerCase().slice(0, 30)}%`;
    product = db.prepare("SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE' AND lower(name) LIKE ? LIMIT 1").get(orgId, like) || null;
  }
  const rules = db.prepare("SELECT * FROM sales_rules WHERE organization_id = ?").get(orgId) || {};
  const analysis = analyzeLead({ db, org: ctx.org, lead: l, messages, product, deal, rules });
  const scoreHistory = db.prepare("SELECT * FROM lead_score_history WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 20").all(orgId, l.id);
  const objections = db.prepare("SELECT * FROM objections WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC").all(orgId, l.id);
  const signals = db.prepare("SELECT * FROM buying_signals WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 20").all(orgId, l.id);
  const coach = salesCoachAnalysis(analysis, l, deal, objections.filter((o) => !o.resolved));

  // Timeline unifiée (spec §25)
  const tl = [];
  tl.push({ at: l.created_at, label: "Lead créé", detail: `Source : ${l.source}` });
  for (const h of scoreHistory) tl.push({ at: h.created_at, label: `Score ${h.previous_score ?? "?"} → ${h.score}`, detail: h.reason });
  for (const o of objections) tl.push({ at: o.created_at, label: `Objection ${o.type} (${o.severity})`, detail: o.resolved ? "résolue" : "ouverte" });
  for (const s of signals) tl.push({ at: s.created_at, label: `Signal d'achat : ${s.type}`, detail: s.text });
  for (const d of deals) tl.push({ at: d.created_at, label: `Opportunité : ${d.name}`, detail: `${d.stage} · ${fmtMoney(d.value, d.currency || ctx.org.currency)}` });
  for (const a of activities) tl.push({ at: a.created_at, label: activityLabel(a.type), detail: a.description });
  for (const n of notes) tl.push({ at: n.created_at, label: "Note", detail: n.content.slice(0, 100) });
  for (const t of tasks) tl.push({ at: t.created_at, label: `Tâche : ${t.title}`, detail: t.status });
  if (conv) tl.push({ at: conv.updated_at, label: "Conversation IA", detail: `${messages.length} message(s)` });
  tl.sort((a, b) => new Date(b.at) - new Date(a.at));
  const timeline = tl.slice(0, 50);

  // Doublons (spec §34)
  const dn = (p) => String(p || "").replace(/\D/g, "");
  const dups = db.prepare("SELECT * FROM leads WHERE organization_id = ? AND id != ?").all(orgId, l.id).filter((c) => {
    if (l.email && c.email && c.email === l.email) return true;
    if (l.phone && c.phone && dn(l.phone).slice(-8) === dn(c.phone).slice(-8)) return true;
    if (l.company_name && c.company_name && c.company_name.toLowerCase() === l.company_name.toLowerCase() && l.name === c.name) return true;
    return false;
  });

  const bant = analysis.bant;
  const nbaLabel = { SEND_PRODUCT: "Envoyer des produits adaptés", SEND_QUOTE: "Envoyer un devis", FOLLOW_UP: "Relancer le prospect", CALL_CUSTOMER: "Appeler le client", SCHEDULE_MEETING: "Planifier un rendez-vous", TRANSFER_HUMAN: "Transmettre au conseiller", ANSWER_OBJECTION: "Traiter l'objection", CHECK_STOCK: "Vérifier le stock / alternative", CREATE_DEAL: "Préparer la commande", WAIT: "Attendre — relance planifiée" }[analysis.next_best_action] || analysis.next_best_action;

  return crmLayout(ctx, l.name, `
  <div class="page-toolbar"><h2>${l.at_risk ? "⚠️ " : ""}${esc(l.name)}</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/dashboard/leads/${l.id}/edit">Modifier</a>
      <button class="btn danger" data-confirm="Supprimer ce lead ?" data-fetch-action="/api/leads/${l.id}" data-method="DELETE">Supprimer</button>
      <a class="btn ghost" href="/dashboard/leads">← Retour</a>
    </div></div>

  ${l.at_risk ? `<div class="alert warn-banner">⚠️ Ce lead risque de se perdre — lead chaud sans réponse récente. ${analysis.follow_up ? `<b>${esc(analysis.follow_up.when)}.</b> <span class="muted-sm">« ${esc(analysis.follow_up.message)} »</span>` : ""}
    <button class="btn small primary" data-fetch-action="/api/smart/leads/${l.id}/follow-up" data-method="POST" data-follow-up>✓ Suivi effectué</button></div>` : ""}

  ${dups.length ? `<div class="card form-card dup-card"><div class="card-head"><h3>⚠️ Doublons détectés (${dups.length})</h3><span class="muted-sm">Fusion manuelle uniquement — jamais automatique</span></div>
    ${dups.map((c) => `<div class="list-line">${esc(c.name)} <span class="muted-sm">${esc(c.email || c.phone || c.company_name || "")}</span>
      <span class="right"><button class="btn small ghost" data-confirm="Fusionner « ${esc(c.name)} » dans « ${esc(l.name)} » ?" data-fetch-action="/api/smart/leads/${l.id}/merge" data-method="POST" data-merge-target="${c.id}">Fusionner</button></span></div>`).join("")}
  </div>` : ""}

  <div class="sales-brief card form-card">
    <div class="card-head"><h3>📋 Sales Brief</h3>
      <button class="btn small ghost" data-coach-reload>🧠 Re-analyser (IA)</button></div>
    <div class="brief-grid">
      <div class="ob-line"><span>Score</span><b class="brief-score">${temperature(l.score)} <span class="muted-sm">/ 100</span></b></div>
      <div class="ob-line"><span>Intention d'achat</span><b>${intentBadge(analysis.purchase_intent)}</b></div>
      <div class="ob-line"><span>Priorité</span><b>${priorityBadge(analysis.priority)}</b></div>
      <div class="ob-line"><span>Probabilité de conversion</span><b>${analysis.conversion_probability} % <span class="muted-sm">(estimation heuristique — signaux commerciaux)</span></b></div>
      <div class="ob-line"><span>BANT</span><b>${bantBadge(bant.budget)} ${bantBadge(bant.authority)} ${bantBadge(bant.need)} ${bantBadge(bant.timeline)} <span class="muted-sm">(B·A·N·T)</span></b></div>
      <div class="ob-line"><span>Budget</span><b>${l.budget !== null ? esc(fmtMoney(l.budget, l.currency || ctx.org.currency)) : "—"}${analysis.dimensions.budget.ratio != null ? ` <span class="muted-sm">(${Math.round(analysis.dimensions.budget.ratio * 100)} % du prix)</span>` : ""}</b></div>
      <div class="ob-line"><span>Produit identifié</span><b>${product ? esc(product.name) : (analysis.dimensions.need.product ? esc(analysis.dimensions.need.product) : "—")}</b></div>
      <div class="ob-line"><span>Valeur estimée</span><b>${analysis.estimated_value != null ? esc(fmtMoney(analysis.estimated_value, l.currency || ctx.org.currency)) : "—"} <span class="muted-sm">(${deal ? "deal" : product ? "catalogue" : "aucune donnée"})</span></b></div>
    </div>
    <div class="brief-reasons">
      <h4>Raisons</h4>
      <ul class="reason-list">
        ${analysis.reasons.map((r) => `<li class="r-plus">+ ${esc(r.text)}</li>`).join("") || "<li class='r-minus'>(aucun signal positif)</li>"}
        ${analysis.negatives.map((n) => `<li class="r-minus">− ${esc(n.text)}</li>`).join("")}
      </ul>
    </div>
    <div class="nba-box">
      <div><b>Action recommandée :</b> ${esc(nbaLabel)}</div>
      <div class="muted-sm">Pourquoi : ${esc(analysis.next_best_action_reason)}</div>
      ${analysis.next_best_action === "CREATE_DEAL" && !deal ? `<div class="form-row" style="margin-top:8px">
        <button class="btn small primary" data-confirm="Créer une opportunité de ${fmtMoney(analysis.estimated_value, l.currency || ctx.org.currency)} ?" data-fetch-action="/api/smart/leads/${l.id}/nba/confirm" data-method="POST">Confirmer le deal</button>
        <button class="btn small ghost" data-fetch-action="/api/smart/leads/${l.id}/nba/dismiss" data-method="POST">Ignorer</button></div>` : ""}
      ${analysis.follow_up && (analysis.next_best_action === "FOLLOW_UP" || analysis.next_best_action === "WAIT") ? `<div class="muted-sm" style="margin-top:6px">⏰ ${esc(analysis.follow_up.when)} — « ${esc(analysis.follow_up.message)} »</div>` : ""}
    </div>
  </div>

  <div class="card form-card">
    <div class="detail-lines">
      <div class="ob-line"><span>Statut</span><b>${leadBadge(l.status)}${l.hot ? " <span title='Hot lead'>🔥 Hot</span>" : ""}</b></div>
      <div class="ob-line"><span>Source</span><b>${esc(l.source)}</b></div>
      <div class="ob-line"><span>Contact</span><b>${esc(l.email || "—")} ${l.phone ? "· " + esc(l.phone) : ""}</b></div>
      <div class="ob-line"><span>Responsable</span><b>
        <form method="POST" action="/api/leads/${l.id}" data-method="PUT" data-fetch class="form-inline assign-form">
          <select name="assigned_to"><option value="">— Non assigné —</option>${assignOpts}</select>
          <button class="btn small ghost">Assigner</button>
        </form></b></div>
      <div class="ob-line"><span>Prochain suivi</span><b>${l.next_followup_at ? esc(new Date(l.next_followup_at).toLocaleDateString("fr-FR")) : "—"}</b></div>
    </div>
    ${l.interest ? `<p class="muted"><b>Intérêt :</b> ${esc(l.interest)}</p>` : ""}
    ${l.notes ? `<p class="muted" style="white-space:pre-wrap">${esc(l.notes)}</p>` : ""}
    ${customer ? `<p class="muted-sm">Client lié : <a href="/dashboard/contacts/${customer.id}">${esc(customer.first_name)} ${esc(customer.last_name)} (Customer 360)</a></p>` : ""}
  </div>

  <div class="two-col">
    <div class="card form-card">
      <div class="card-head"><h3>Opportunités</h3><a class="btn small ghost" href="/dashboard/deals/new?lead_id=${l.id}">+ Deal</a></div>
      ${deals.length ? deals.map((d) => `<a class="list-line" href="/dashboard/deals/${d.id}">${esc(d.name)} ${dealStageBadge(d.stage)} <span class="muted-sm">${esc(fmtMoney(d.value, d.currency || ctx.org.currency))}</span></a>`).join("") : '<p class="muted">Aucune opportunité liée.</p>'}
      ${analysis.deal ? `<div class="muted-sm" style="margin-top:8px">Risque deal : ${riskBadge(analysis.deal.risk)} · Santé : ${healthBadge(analysis.deal.health)}${analysis.deal.risk_factors.length ? ` <span class="muted-sm">(${esc(analysis.deal.risk_factors.join(", "))})</span>` : ""}</div>` : ""}
      <div class="card-head" style="margin-top:14px"><h3>Tâches</h3><a class="btn small ghost" href="/dashboard/tasks/new?lead_id=${l.id}">+ Tâche</a></div>
      ${tasks.length ? tasks.map((t) => `<div class="list-line">${t.status === "COMPLETED" ? "✅" : t.status === "IN_PROGRESS" ? "🔄" : "⬜"} ${esc(t.title)} <span class="muted-sm">${esc(t.priority)}${t.due_date ? " · " + esc(t.due_date) : ""}</span></div>`).join("") : '<p class="muted">Aucune tâche.</p>'}
    </div>
    <div class="card form-card">
      <div class="card-head"><h3>Notes</h3></div>
      <form method="POST" action="/api/notes" data-fetch data-note-form data-lead="${l.id}" class="form-inline">
        <input type="text" name="content" placeholder="Nouvelle note…" required maxlength="5000"/>
        <button class="btn primary small">Ajouter</button>
      </form>
      ${notes.map((n) => `<div class="note-block">${esc(n.content)}<div class="note-meta muted-sm">${esc(n.user_name || "")} · ${esc(new Date(n.created_at).toLocaleDateString("fr-FR"))}
        <button class="btn small ghost" data-edit-note data-note-id="${n.id}" data-content="${esc(n.content)}">Modifier</button>
        <button class="btn small danger" data-confirm="Supprimer ?" data-fetch-action="/api/notes/${n.id}" data-method="DELETE">Supprimer</button></div></div>`).join("") || '<p class="muted">Aucune note.</p>'}
    </div>
  </div>

  <div class="two-col">
    <div class="card form-card">
      <div class="card-head"><h3>🧠 Coach IA</h3><span class="muted-sm">Analyse pour le commercial</span></div>
      <p class="muted">${esc(coach.summary)}</p>
      <div class="detail-lines">
        ${coach.strengths.length ? `<div class="ob-line"><span>Forces</span><b>${coach.strengths.map(esc).join(" · ")}</b></div>` : ""}
        ${coach.objections.length ? `<div class="ob-line"><span>Objections</span><b>${coach.objections.map(esc).join(" · ")}</b></div>` : ""}
        ${coach.risks.length ? `<div class="ob-line"><span>Risques</span><b>${coach.risks.map(esc).join(" · ")}</b></div>` : ""}
        <div class="ob-line"><span>Opportunité</span><b>${esc(coach.opportunity)}</b></div>
        <div class="ob-line"><span>Action</span><b>${esc(coach.recommended_action)}</b></div>
      </div>
      ${scoreHistory.length ? `<h4 style="margin-top:14px">Historique du score</h4>
        <div class="detail-lines">${scoreHistory.map((h) => `<div class="ob-line"><span>${esc(new Date(h.created_at).toLocaleDateString("fr-FR"))}</span><b>${h.previous_score ?? "—"} → ${h.score} <span class="muted-sm">(${h.change > 0 ? "+" : ""}${h.change})</span></b></div>`).join("")}</div>` : ""}
    </div>
    <div class="card form-card">
      <div class="card-head"><h3>Objections</h3></div>
      ${objections.length ? objections.map((o) => `<div class="note-block">
        <b>${esc(o.type)}</b> ${o.severity === "CRITICAL" ? '<span class="badge-l" style="background:var(--danger-soft);color:var(--danger)">CRITICAL</span>' : o.severity === "HIGH" ? '<span class="badge-l" style="background:var(--warn-soft);color:var(--warn)">HIGH</span>' : `<span class="badge-l" style="background:var(--surface-2);color:var(--muted)">${esc(o.severity)}</span>`}
        <div class="muted-sm">${esc(o.text || "")} · ${esc(new Date(o.created_at).toLocaleDateString("fr-FR"))}</div>
        ${o.resolved ? '<span class="tag ok">Résolue</span>' : `<button class="btn small ghost" data-confirm="Marquer comme résolue ?" data-fetch-action="/api/smart/leads/${l.id}/objections/${o.id}/resolve" data-method="POST">✓ Résoudre</button>`}
      </div>`).join("") : '<p class="muted">Aucune objection détectée.</p>'}
      ${signals.length ? `<h4 style="margin-top:14px">Signaux d'achat</h4>
        ${signals.map((s) => `<div class="list-line">⚡ ${esc(s.type)} <span class="muted-sm">${esc(s.confidence)} % · ${esc(new Date(s.created_at).toLocaleDateString("fr-FR"))}</span></div>`).join("")}` : ""}
    </div>
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Timeline</h3><span class="muted-sm">Conversation · scores · intentions · objections · activités · tâches · notes · deals</span></div>
    ${timeline.length ? `<div class="timeline">${timeline.map((t) => `<div class="timeline-item">
      <span class="timeline-dot"></span>
      <div><b>${esc(t.label)}</b> ${t.detail ? `— ${esc(t.detail)}` : ""}
      <div class="muted-sm">${esc(new Date(t.at).toLocaleString("fr-FR"))}</div></div>
    </div>`).join("")}</div>` : '<p class="muted">Aucun événement.</p>'}
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Historique des activités</h3></div>
    <form method="POST" action="/api/activities" data-fetch data-activity-form data-lead="${l.id}" data-customer="${customer ? customer.id : ""}" class="form-inline">
      <select name="type"><option>CALL</option><option>EMAIL</option><option>MESSAGE</option><option>MEETING</option><option>FOLLOW_UP</option><option>NOTE</option></select>
      <input type="text" name="description" placeholder="Détails (optionnel)" maxlength="500"/>
      <button class="btn primary small">Enregistrer</button>
    </form>
    ${activities.length ? `<div class="timeline" style="margin-top:12px">${activities.map((a) => `<div class="timeline-item">
      <span class="timeline-dot"></span>
      <div><b>${activityLabel(a.type)}</b> ${a.description ? `— ${esc(a.description)}` : ""}
      <div class="muted-sm">${esc(a.user_name || "")} · ${esc(new Date(a.created_at).toLocaleString("fr-FR"))}</div></div>
    </div>`).join("")}</div>` : '<p class="muted">Aucune activité.</p>'}
  </div>`);
}

export function leadKanbanPage(ctx, { columns }) {
  return crmLayout(ctx, "Pipeline", `
  <div class="page-toolbar"><h2>Pipeline commercial</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/dashboard/leads">☰ Vue liste</a>
      <a class="btn primary" href="/dashboard/leads/new">+ Nouveau lead</a>
    </div></div>
  <p class="muted-sm">Glissez-déposez une carte pour changer son statut. Chaque déplacement est journalisé.</p>
  <div class="kanban" id="kanban">
    ${Object.entries(columns).map(([status, items]) => `
    <div class="kanban-col" data-status="${status}">
      <div class="kanban-head">${esc(LEAD_STATUS_LABELS[status] || status)} <span class="kanban-count">${items.length}</span></div>
      <div class="kanban-cards" data-dropzone="${status}">
        ${items.map((l) => `
        <div class="kanban-card" draggable="true" data-lead-id="${l.id}" data-status="${status}">
          <div class="kc-name"><a href="/dashboard/leads/${l.id}">${esc(l.name)}</a></div>
          ${l.company_name ? `<div class="kc-sub">${esc(l.company_name)}</div>` : ""}
          <div class="kc-meta">
            ${temperature(l.score)}
            ${l.budget !== null ? `<span class="muted-sm">${esc(fmtMoney(l.budget, l.currency || ctx.org.currency))}</span>` : ""}
          </div>
          <div class="kc-meta muted-sm">
            <span>${esc(l.source)}</span>
            <span>${esc(l.assigned_to_name || "Non assigné")}</span>
            ${l.next_followup_at ? `<span title="Prochain suivi">${esc(new Date(l.next_followup_at).toLocaleDateString("fr-FR"))}</span>` : ""}
          </div>
        </div>`).join("")}
      </div>
    </div>`).join("")}
  </div>`);
}

/* ============================ DEALS ============================ */
export function dealsPage(ctx, { deals, pagination, q, members }) {
  const assignOpts = [{ value: "none", label: "Non assigné" }, { value: "me", label: "Moi" }, ...members.map((m) => ({ value: m.user_id, label: `${m.first_name} ${m.last_name}` }))];
  return crmLayout(ctx, "Deals", `
  <div class="page-toolbar"><h2>Opportunités (Deals)</h2>
    <a class="btn primary" href="/dashboard/deals/new">+ Nouvelle opportunité</a></div>
  <div class="card filters-card">
    <form method="GET" action="/dashboard/deals" class="form-inline filters">
      <input type="search" name="q" value="${esc(q.q || "")}" placeholder="Rechercher…"/>
      ${select("f_stage", "stage", DEAL_STAGES.map((s) => ({ value: s, label: s })), q.stage, "Étape")}
      ${select("f_assign", "assigned_to", assignOpts, q.assigned_to, "Responsable")}
      <input type="number" name="min_value" value="${esc(q.min_value || "")}" placeholder="Valeur min" class="narrow" min="0"/>
      <input type="date" name="date_from" value="${esc(q.date_from || "")}"/>
      <input type="date" name="date_to" value="${esc(q.date_to || "")}"/>
      <button type="submit" class="btn ghost">Filtrer</button>
    </form>
  </div>
  ${deals.length ? `<div class="card table-card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Opportunité</th><th>Client</th><th>Valeur</th><th>Étape</th><th>Probab.</th><th>Valeur attendue</th><th>Santé</th><th>Risque</th><th>Clôture</th><th class="right"></th></tr></thead>
    <tbody>${deals.map((d) => `<tr>
      <td class="strong"><a class="row-link" href="/dashboard/deals/${d.id}">${esc(d.name)}</a></td>
      <td class="muted-sm">${esc(d.customer_name || "—")}</td>
      <td>${esc(fmtMoney(d.value, d.currency || ctx.org.currency))}</td>
      <td>${dealStageBadge(d.stage)}</td>
      <td>${d.probability} %</td>
      <td><b>${esc(fmtMoney(d.expected_value, d.currency || ctx.org.currency))}</b></td>
      <td>${healthBadge(d.health)}</td>
      <td>${riskBadge(d.risk)}</td>
      <td class="muted-sm">${d.expected_close_date ? esc(new Date(d.expected_close_date).toLocaleDateString("fr-FR")) : "—"}</td>
      <td class="right"><a class="btn small ghost" href="/dashboard/deals/${d.id}">Voir</a></td>
    </tr>`).join("")}</tbody>
  </table></div>
  ${paginationHtml(pagination, "/dashboard/deals" + (q.q ? `?q=${encodeURIComponent(q.q)}` : ""))}</div>` : `
  <div class="card empty-state"><span class="empty-ico">💼</span>
    <h3>Aucune opportunité pour le moment.</h3>
    <div class="empty-actions"><a class="btn primary" href="/dashboard/deals/new">+ Créer une opportunité</a></div>
  </div>`}
  `);
}

const DEAL_STAGES = ["NEW", "QUALIFICATION", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];

export function dealFormPage(ctx, { deal, products, customers, leads, members }) {
  const d = deal || { name: "", description: "", value: "", stage: "NEW", probability: 50, expected_close_date: "" };
  return crmLayout(ctx, deal ? "Modifier l'opportunité" : "Nouvelle opportunité", `
  <div class="page-toolbar"><h2>${deal ? "Modifier l'opportunité" : "Nouvelle opportunité"}</h2><a class="btn ghost" href="/dashboard/deals">← Retour</a></div>
  <form method="POST" action="/api/deals" ${deal ? `data-method="PUT" data-id="${d.id}"` : ""} data-fetch class="form card form-card" novalidate>
    <div class="field"><label for="name">Nom *</label><input id="name" name="name" value="${esc(d.name)}" required maxlength="120"/></div>
    <div class="field-2col">
      <div class="field"><label for="customer_id">Client</label><select id="customer_id" name="customer_id">
        <option value="">— Aucun —</option>
        ${customers.map((c) => `<option value="${c.id}"${d.customer_id === c.id ? " selected" : ""}>${esc(c.first_name)} ${esc(c.last_name)}${c.company_name ? " — " + esc(c.company_name) : ""}</option>`).join("")}
      </select></div>
      <div class="field"><label for="lead_id">Lead lié</label><select id="lead_id" name="lead_id">
        <option value="">— Aucun —</option>
        ${leads.map((l) => `<option value="${l.id}"${d.lead_id === l.id ? " selected" : ""}>${esc(l.name)}</option>`).join("")}
      </select></div>
    </div>
    <div class="field-3col">
      <div class="field"><label for="value">Valeur *</label><input id="value" name="value" type="number" min="0" step="0.01" value="${esc(d.value)}" required/></div>
      <div class="field"><label for="probability">Probabilité (%)</label><input id="probability" name="probability" type="number" min="0" max="100" value="${esc(d.probability)}"/></div>
      <div class="field"><label for="stage">Étape</label><select id="stage" name="stage">
        ${DEAL_STAGES.map((s) => `<option${d.stage === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
    </div>
    <div class="field-2col">
      <div class="field"><label for="expected_close_date">Clôture prévue</label><input id="expected_close_date" name="expected_close_date" type="date" value="${d.expected_close_date ? esc(String(d.expected_close_date).slice(0, 10)) : ""}"/></div>
      ${deal ? `<div class="field"><label for="assigned_to">Responsable</label><select id="assigned_to" name="assigned_to"><option value="">—</option>
        ${members.map((m) => `<option value="${m.user_id}"${d.assigned_to === m.user_id ? " selected" : ""}>${esc(m.first_name)} ${esc(m.last_name)}</option>`).join("")}</select></div>` : ""}
    </div>
    <div class="field"><label for="description">Description</label><textarea id="description" name="description" rows="3">${esc(d.description || "")}</textarea></div>
    <div class="form-row"><button type="submit" class="btn primary">${deal ? "Enregistrer" : "Créer l'opportunité"}</button></div>
  </form>
  ${deal ? `
  <div class="card form-card">
    <div class="card-head"><h3>Produits de l'opportunité</h3></div>
    <form method="POST" action="/api/deals/${deal.id}/products" data-fetch class="form-inline add-line">
      <select name="product_id">${products.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(fmtMoney(p.discount_price ?? p.price, p.currency || ctx.org.currency))})</option>`).join("")}</select>
      <input type="number" name="quantity" min="1" value="1" class="narrow" aria-label="Quantité"/>
      <input type="number" name="unit_price" min="0" step="0.01" class="narrow" placeholder="Prix unitaire" aria-label="Prix unitaire"/>
      <input type="number" name="discount" min="0" step="0.01" class="narrow" placeholder="Remise" aria-label="Remise"/>
      <button class="btn primary small">Ajouter</button>
    </form>
  </div>` : ""}
  `);
}

export function dealDetailPage(ctx, { deal: d, products: lines, activities, notes, customer, lead }) {
  const total = lines.reduce((s, l) => s + l.total, 0);
  return crmLayout(ctx, d.name, `
  <div class="page-toolbar"><h2>${esc(d.name)}</h2>
    <div class="toolbar-actions">
      <a class="btn ghost" href="/dashboard/deals/${d.id}/edit">Modifier</a>
      <button class="btn danger" data-confirm="Supprimer cette opportunité ?" data-fetch-action="/api/deals/${d.id}" data-method="DELETE">Supprimer</button>
      <a class="btn ghost" href="/dashboard/deals">← Retour</a>
    </div></div>
  <div class="card form-card">
    <div class="detail-lines">
      <div class="ob-line"><span>Étape</span><b>${dealStageBadge(d.stage)}</b></div>
      <div class="ob-line"><span>Valeur</span><b>${esc(fmtMoney(d.value, d.currency || ctx.org.currency))}</b></div>
      <div class="ob-line"><span>Probabilité</span><b>${d.probability} %</b></div>
      <div class="ob-line"><span>Valeur attendue</span><b style="color:var(--success)">${esc(fmtMoney(d.expected_value, d.currency || ctx.org.currency))}</b></div>
      ${(() => { const last = (lead && lead.last_contact_at) || d.updated_at || d.created_at; const days = (Date.now() - new Date(last).getTime()) / 86400000; const openCrit = ctx.db.prepare("SELECT COUNT(*) n FROM objections WHERE lead_id = ? AND resolved = 0 AND severity IN ('HIGH','CRITICAL')").get(d.lead_id || "").n; let risk = "LOW"; if (days >= 7) risk = "MEDIUM"; if (openCrit > 0) risk = "HIGH"; if (d.probability <= 30 && risk === "LOW") risk = "MEDIUM"; if (days >= 14) risk = "HIGH"; const health = d.stage === "WON" ? "Won" : d.stage === "LOST" ? "Lost" : days >= 10 ? "Stalled" : risk !== "LOW" ? "At Risk" : "Healthy"; return `<div class="ob-line"><span>Santé du deal</span><b>${healthBadge(health)} ${riskBadge(risk)}</b></div>`; })()}
      <div class="ob-line"><span>Clôture prévue</span><b>${d.expected_close_date ? esc(new Date(d.expected_close_date).toLocaleDateString("fr-FR")) : "—"}</b></div>
      <div class="ob-line"><span>Client</span><b>${customer ? `<a href="/dashboard/contacts/${customer.id}">${esc(customer.first_name)} ${esc(customer.last_name)}</a>` : "—"}</b></div>
      <div class="ob-line"><span>Lead</span><b>${lead ? `<a href="/dashboard/leads/${lead.id}">${esc(lead.name)}</a>` : "—"}</b></div>
      <div class="ob-line"><span>Responsable</span><b>${esc(d.assigned_to_name || "—")}</b></div>
    </div>
    ${d.description ? `<p class="muted" style="white-space:pre-wrap">${esc(d.description)}</p>` : ""}
  </div>

  <div class="card form-card">
    <div class="card-head"><h3>Produits</h3><span class="muted-sm">total = quantité × prix unitaire − remise</span></div>
    <form method="POST" action="/api/deals/${d.id}/products" data-fetch class="form-inline add-line">
      <select name="product_id">${ctx._products.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(fmtMoney(p.discount_price ?? p.price, p.currency || ctx.org.currency))})</option>`).join("")}</select>
      <input type="number" name="quantity" min="1" value="1" class="narrow" aria-label="Quantité"/>
      <input type="number" name="unit_price" min="0" step="0.01" class="narrow" placeholder="Prix unitaire"/>
      <input type="number" name="discount" min="0" step="0.01" class="narrow" placeholder="Remise"/>
      <button class="btn primary small">Ajouter</button>
    </form>
    ${lines.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Produit</th><th>Qté</th><th>Prix unitaire</th><th>Remise</th><th>Total</th><th class="right"></th></tr></thead>
      <tbody>${lines.map((l) => `<tr>
        <td class="strong">${esc(l.product_name)}</td>
        <td>${l.quantity}</td>
        <td>${esc(fmtMoney(l.unit_price, d.currency || ctx.org.currency))}</td>
        <td>${l.discount ? esc(fmtMoney(l.discount, d.currency || ctx.org.currency)) : "—"}</td>
        <td><b>${esc(fmtMoney(l.total, d.currency || ctx.org.currency))}</b></td>
        <td class="right"><button class="btn small danger" data-confirm="Retirer cette ligne ?" data-fetch-action="/api/deal-products/${l.id}" data-method="DELETE">✕</button></td>
      </tr>`).join("")}</tbody>
    </table></div>
    <p style="text-align:right"><b>Total : ${esc(fmtMoney(total, d.currency || ctx.org.currency))}</b></p>` : '<p class="muted">Aucun produit dans cette opportunité.</p>'}
  </div>

  <div class="two-col">
    <div class="card form-card">
      <div class="card-head"><h3>Notes</h3></div>
      <form method="POST" action="/api/notes" data-fetch data-note-form data-deal="${d.id}" class="form-inline">
        <input type="text" name="content" placeholder="Nouvelle note…" required maxlength="5000"/>
        <button class="btn primary small">Ajouter</button>
      </form>
      ${notes.map((n) => `<div class="note-block">${esc(n.content)}<div class="note-meta muted-sm">${esc(n.user_name || "")} · ${esc(new Date(n.created_at).toLocaleDateString("fr-FR"))}
        <button class="btn small danger" data-confirm="Supprimer ?" data-fetch-action="/api/notes/${n.id}" data-method="DELETE">Supprimer</button></div></div>`).join("") || '<p class="muted">Aucune note.</p>'}
    </div>
    <div class="card form-card">
      <div class="card-head"><h3>Historique</h3></div>
      <form method="POST" action="/api/activities" data-fetch data-activity-form data-deal="${d.id}" data-lead="${lead ? lead.id : ""}" data-customer="${customer ? customer.id : ""}" class="form-inline">
        <select name="type"><option>CALL</option><option>EMAIL</option><option>MEETING</option><option>FOLLOW_UP</option><option>NOTE</option><option>PURCHASE</option></select>
        <input type="text" name="description" placeholder="Détails" maxlength="500"/>
        <button class="btn primary small">Enregistrer</button>
      </form>
      <div class="timeline" style="margin-top:12px">${activities.map((a) => `<div class="timeline-item">
        <span class="timeline-dot"></span>
        <div><b>${esc(activityLabel(a.type))}</b> ${a.description ? `— ${esc(a.description)}` : ""}
        <div class="muted-sm">${esc(a.user_name || "")} · ${esc(new Date(a.created_at).toLocaleString("fr-FR"))}</div></div>
      </div>`).join("") || '<p class="muted">Aucune activité.</p>'}</div>
    </div>
  </div>`);
}

/* ============================ TÂCHES ============================ */
export function tasksPage(ctx, { tasks, pagination, q, members }) {
  const assignOpts = [{ value: "none", label: "Non assignée" }, { value: "me", label: "À moi" }, ...members.map((m) => ({ value: m.user_id, label: `${m.first_name} ${m.last_name}` }))];
  return crmLayout(ctx, "Tâches", `
  <div class="page-toolbar"><h2>Tâches</h2><a class="btn primary" href="/dashboard/tasks/new">+ Nouvelle tâche</a></div>
  <div class="card filters-card">
    <form method="GET" action="/dashboard/tasks" class="form-inline filters">
      ${select("f_status", "status", ["TODO", "IN_PROGRESS", "COMPLETED", "CANCELLED"].map((s) => ({ value: s, label: s })), q.status, "Statut")}
      ${select("f_priority", "priority", ["URGENT", "HIGH", "MEDIUM", "LOW"].map((s) => ({ value: s, label: s })), q.priority, "Priorité")}
      ${select("f_assign", "assigned_to", assignOpts, q.assigned_to, "Assignée à")}
      <button type="submit" class="btn ghost">Filtrer</button>
    </form>
  </div>
  ${tasks.length ? `<div class="card table-card"><div class="table-wrap"><table class="table">
    <thead><tr><th>Tâche</th><th>Priorité</th><th>Statut</th><th>Assignée à</th><th>Échéance</th><th class="right"></th></tr></thead>
    <tbody>${tasks.map((t) => `<tr>
      <td class="strong">${esc(t.title)}${t.description ? `<div class="muted-sm">${esc(t.description.slice(0, 60))}</div>` : ""}</td>
      <td><span class="prio p-${t.priority.toLowerCase()}">${esc(t.priority)}</span></td>
      <td><a class="row-link" href="/dashboard/tasks" title="Changer le statut via l'API/formulaire">${esc(t.status)}</a></td>
      <td>${esc(t.assigned_to_name || "—")}</td>
      <td class="muted-sm">${t.due_date ? esc(new Date(t.due_date).toLocaleDateString("fr-FR")) : "—"}</td>
      <td class="right">
        ${t.status !== "COMPLETED" ? `<button class="btn small ghost" data-task-done="${t.id}">✓ Terminer</button>` : ""}
        <button class="btn small danger" data-confirm="Supprimer cette tâche ?" data-fetch-action="/api/tasks/${t.id}" data-method="DELETE">✕</button>
      </td>
    </tr>`).join("")}</tbody>
  </table></div>
  ${paginationHtml(pagination, "/dashboard/tasks")}</div>` : `
  <div class="card empty-state"><span class="empty-ico">✅</span>
    <h3>Aucune tâche pour le moment.</h3>
    <div class="empty-actions"><a class="btn primary" href="/dashboard/tasks/new">+ Créer une tâche</a></div>
  </div>`}
  `);
}

export function taskFormPage(ctx, { task, members, customer, lead, deal }) {
  const t = task || { title: "", description: "", priority: "MEDIUM", due_date: "" };
  return crmLayout(ctx, task ? "Modifier la tâche" : "Nouvelle tâche", `
  <div class="page-toolbar"><h2>${task ? "Modifier la tâche" : "Nouvelle tâche"}</h2><a class="btn ghost" href="/dashboard/tasks">← Retour</a></div>
  <form method="POST" action="/api/tasks" ${task ? `data-method="PUT" data-id="${t.id}"` : ""} data-fetch class="form card form-card" novalidate>
    <div class="field"><label for="title">Titre *</label><input id="title" name="title" value="${esc(t.title)}" required maxlength="200"/></div>
    <div class="field"><label for="description">Description</label><textarea id="description" name="description" rows="3">${esc(t.description || "")}</textarea></div>
    <div class="field-3col">
      <div class="field"><label for="priority">Priorité</label><select id="priority" name="priority">
        ${["LOW", "MEDIUM", "HIGH", "URGENT"].map((s) => `<option${t.priority === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label for="due_date">Échéance</label><input id="due_date" name="due_date" type="date" value="${t.due_date ? esc(String(t.due_date).slice(0, 10)) : ""}"/></div>
      <div class="field"><label for="assigned_to">Assignée à</label><select id="assigned_to" name="assigned_to"><option value="">—</option>
        ${members.map((m) => `<option value="${m.user_id}"${t.assigned_to === m.user_id ? " selected" : ""}>${esc(m.first_name)} ${esc(m.last_name)}</option>`).join("")}</select></div>
    </div>
    <div class="form-row"><button type="submit" class="btn primary">${task ? "Enregistrer" : "Créer la tâche"}</button></div>
  </form>`);
}

/* ============================ RECHERCHE ============================ */
export function searchPage(ctx, { q, groups }) {
  const item = (label, sub) => `<div class="search-item"><b>${esc(label)}</b>${sub ? ` <span class="muted-sm">${esc(sub)}</span>` : ""}</div>`;
  const has = groups.products.length || groups.customers.length || groups.leads.length || groups.deals.length;
  return crmLayout(ctx, "Recherche", `
  <div class="page-toolbar"><h2>Recherche globale</h2></div>
  <div class="card filters-card">
    <form method="GET" action="/dashboard/search" class="form-inline">
      <input type="search" name="q" value="${esc(q)}" placeholder="Produits, clients, leads, deals…" required/>
      <button class="btn primary">Rechercher</button>
    </form>
  </div>
  ${!q ? "" : !has ? `<div class="card empty-state"><span class="empty-ico">🔍</span><h3>Aucun résultat pour « ${esc(q)} ».</h3></div>` : `
  <div class="search-groups">
    ${groups.products.length ? `<div class="card form-card"><h3>📦 Produits (${groups.products.length})</h3>
      ${groups.products.map((p) => item(`<a class="row-link" href="/dashboard/products/${p.id}">${p.name}</a>`, `${p.sku || ""} · ${fmtMoney(p.price, p.currency || ctx.org.currency)}`)).join("")}</div>` : ""}
    ${groups.customers.length ? `<div class="card form-card"><h3>👥 Clients (${groups.customers.length})</h3>
      ${groups.customers.map((c) => item(`<a class="row-link" href="/dashboard/contacts/${c.id}">${c.first_name} ${c.last_name}</a>`, c.company_name || c.email || "")).join("")}</div>` : ""}
    ${groups.leads.length ? `<div class="card form-card"><h3>🎯 Leads (${groups.leads.length})</h3>
      ${groups.leads.map((l) => item(`<a class="row-link" href="/dashboard/leads/${l.id}">${l.name}</a>`, `${l.company_name || ""} · ${LEAD_STATUS_LABELS[l.status] || l.status}`)).join("")}</div>` : ""}
    ${groups.deals.length ? `<div class="card form-card"><h3>💼 Deals (${groups.deals.length})</h3>
      ${groups.deals.map((d) => item(`<a class="row-link" href="/dashboard/deals/${d.id}">${d.name}</a>`, `${fmtMoney(d.value, d.currency || ctx.org.currency)} · ${d.stage}`)).join("")}</div>` : ""}
  </div>`}
  `);
}

/* ============================ DASHBOARD COMMERCIAL ============================ */
function barChart(items, { valueKey = "count", color = "var(--primary)" } = {}) {
  const max = Math.max(...items.map((i) => i[valueKey]), 1);
  if (!items.length) return `<p class="muted" style="padding:8px 0">Aucune donnée sur la période.</p>`;
  return `<div class="bar-chart">${items.map((i) => `
    <div class="bar-col" title="${esc(i.day)} : ${i[valueKey]}">
      <div class="bar" style="height:${Math.max((i[valueKey] / max) * 100, 4)}%; background:${color}"></div>
      <span class="bar-label">${esc(String(i.day).slice(5))}</span>
    </div>`).join("")}</div>`;
}

export function dashboardPage(ctx, { stats, period, user, org, ai, phase5 }) {
  const cards = [
    { label: "Total Leads", value: stats.total_leads, ico: "🎯" },
    { label: "Leads qualifiés", value: stats.qualified_leads, ico: "" },
    { label: "Leads chauds", value: stats.hot_leads, ico: "🔥" },
    { label: "Deals ouverts", value: stats.open_deals, ico: "💼" },
    { label: "Deals gagnés", value: stats.won_deals, ico: "🏆" },
    { label: "Valeur pipeline", value: fmtMoney(stats.pipeline_value, org.currency), ico: "📈" },
    { label: "Valeur attendue", value: fmtMoney(stats.expected_value, org.currency), ico: "🎯" },
    { label: "Taux de conversion", value: stats.conversion_rate !== null ? `${stats.conversion_rate} %` : "—", ico: "⚡" },
  ];
  // Cartes IA (spec §44) — 0 / — si aucune donnée
  const aiCards = ai ? [
    { label: "AI Conversations", value: ai.total_conversations, ico: "💬" },
    { label: "AI Leads", value: ai.ai_leads, ico: "🤖" },
    { label: "AI Qualified", value: ai.qualified_leads, ico: "✅" },
    { label: "AI Hot", value: ai.hot_leads, ico: "🔥" },
    { label: "AI Resolution", value: ai.resolution_rate !== null ? `${ai.resolution_rate} %` : "—", ico: "⚡" },
    { label: "Human Handoffs", value: ai.human_handoffs, ico: "🤝" },
    { label: "AI Usage (mois)", value: ai.usage_month, ico: "📊" },
  ] : null;
  const periods = [["7d", "7 jours"], ["30d", "30 jours"], ["90d", "90 jours"], ["year", "Cette année"]];
  return appLayout({
    title: "Dashboard",
    user: ctx.user, org: ctx.org, role: ctx.member.role, path: "/dashboard", csrf: ctx.csrf,
    content: `
    <section class="page-head">
      <div>
        <h2>Bonjour, ${esc(user.first_name)} 👋</h2>
        <p class="muted">Entreprise : <strong>${esc(org.name)}</strong> · ${esc(org.currency)} · Plan ${esc(org._plan || "FREE")}</p>
      </div>
    </section>

    ${Number(stats.total_leads) === 0 && Number(stats.open_deals) === 0 ? `
    <div class="card" style="margin-bottom:16px;padding:16px;border-color:color-mix(in srgb,#4f46e5 30%,transparent);background:color-mix(in srgb,#4f46e5 6%,transparent)">
      <h3 style="margin:0 0 8px">🚀 Démarrez en 3 minutes</h3>
      <ol style="margin:0;padding-left:18px;line-height:1.8;color:var(--muted,#64748b)">
        <li><a href="/dashboard/products">Ajoutez un produit</a> (prix + stock) — l'agent s'active automatiquement</li>
        <li><a href="/dashboard/agent/playground">Testez l'agent</a> : « Quel est le prix de … ? »</li>
        <li><a href="/dashboard/channels">Copiez le lien widget</a> pour vos prospects (chat public)</li>
      </ol>
    </div>` : ""}

    <div class="stat-grid">${cards.map((c) => `<div class="card stat-card">
      <span class="stat-ico plain">${c.ico}</span>
      <div><span class="stat-value">${esc(String(c.value))}</span><span class="stat-label">${c.label}</span></div>
    </div>`).join("")}</div>

    ${aiCards ? `<section class="ai-section">
      <h3 class="ai-section-title">Intelligence artificielle <a class="muted-sm" href="/dashboard/agent">→ agent</a></h3>
      <div class="stat-grid ai-grid">${aiCards.map((c) => `<div class="card stat-card ai-card">
        <span class="stat-ico plain">${c.ico}</span>
        <div><span class="stat-value">${esc(String(c.value))}</span><span class="stat-label">${c.label}</span></div>
      </div>`).join("")}</div>
    </section>` : ""}

    ${phase5 ? `<section class="ai-section">
      <h3 class="ai-section-title">Automatisation commerciale <a class="muted-sm" href="/dashboard/automation/analytics">→ analytics</a></h3>
      <div class="stat-grid ai-grid">
        ${[
          { label: "Automations actives", value: phase5.automations, ico: "⚙️", href: "/dashboard/automations" },
          { label: "Follow-ups en attente", value: phase5.followups, ico: "⏰", href: "/dashboard/followups" },
          { label: "Campagnes actives", value: phase5.campaigns, ico: "📣", href: "/dashboard/campaigns" },
          { label: "Leads à risque", value: phase5.at_risk, ico: "⚠️", href: "/dashboard/leads?filter=at_risk" },
          { label: "Tâches ouvertes", value: phase5.tasks, ico: "✅", href: "/dashboard/tasks" },
          { label: "Revenue associé", value: fmtMoney(phase5.revenue_associated, org.currency), ico: "💰", href: "/dashboard/automation/analytics" },
        ].map((c) => `<a class="card stat-card ai-card stat-link" href="${c.href}">
          <span class="stat-ico plain">${c.ico}</span>
          <div><span class="stat-value">${esc(String(c.value))}</span><span class="stat-label">${c.label}</span></div>
        </a>`).join("")}
        ${phase5.prediction ? `<div class="card stat-card ai-card">
          <span class="stat-ico plain"></span>
          <div><span class="stat-value" style="font-size:14px">${esc(phase5.prediction.label)}</span><span class="stat-label">Prédiction — ${esc(phase5.prediction.status)}</span></div>
        </div>` : ""}
      </div>
    </section>` : ""}

    <div class="card filters-card">
      <form method="GET" action="/dashboard" class="form-inline filters">
        ${periods.map(([v, l]) => `<label class="period-chip"><input type="radio" name="period" value="${v}"${(!ctx.query || !ctx.query.period || ctx.query.period === v) ? " checked" : ""}/>${l}</label>`).join("")}
        <label class="period-chip"><input type="radio" name="period" value="custom"${ctx.query && ctx.query.period === "custom" ? " checked" : ""}/>Personnalisé</label>
        <input type="date" name="from" value="${esc((ctx.query && ctx.query.from) || "")}"/>
        <input type="date" name="to" value="${esc((ctx.query && ctx.query.to) || "")}"/>
        <button class="btn small ghost">Appliquer</button>
      </form>
    </div>

    <div class="two-col">
      <div class="card form-card"><h3>Leads par jour</h3>${barChart(period.leads)}</div>
      <div class="card form-card"><h3>Deals créés par jour</h3>${barChart(period.deals, { color: "#7c3aed" })}</div>
      <div class="card form-card"><h3>Revenu gagné par jour</h3>${barChart(period.won, { valueKey: "total", color: "var(--success)" })}</div>
      <div class="card form-card"><h3>Pipeline par étape</h3>
        ${period.pipelineByStage.length ? `<div class="stage-list">${period.pipelineByStage.map((s) => `
          <div class="stage-row"><span class="stage-name">${dealStageBadge(s.stage)}</span>
          <div class="stage-bar"><div style="width:${Math.max((s.total / Math.max(...period.pipelineByStage.map((x) => x.total), 1)) * 100, 3)}%"></div></div>
          <span class="muted-sm">${fmtMoney(s.total, org.currency)} (${s.count})</span></div>`).join("")}</div>` : '<p class="muted">Aucun deal ouvert.</p>'}
      </div>
      <div class="card form-card"><h3>Sources des leads</h3>
        ${period.sources.length ? `<ul class="source-list">${period.sources.map((s) => `<li><span>${esc(s.source)}</span><b>${s.count}</b></li>`).join("")}</ul>` : '<p class="muted">Aucun lead pour le moment.</p>'}
      </div>
      <div class="card form-card"><h3>Produits les plus vendus</h3>
        ${period.topProducts.length ? `<ul class="source-list">${period.topProducts.map((p) => `<li><span>${esc(p.name)}</span><b>${p.quantity} vendus · ${fmtMoney(p.revenue, org.currency)}</b></li>`).join("")}</ul>` : '<p class="muted">Aucune vente enregistrée pour le moment.</p>'}
      </div>
    </div>
    `,
  });
}

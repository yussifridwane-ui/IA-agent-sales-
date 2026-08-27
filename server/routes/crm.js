// server/routes/crm.js — Phase 2 : API du moteur commercial
// Catalogue (catégories, produits, variantes, images, CSV) + CRM (clients, leads, deals,
// activités, notes, tâches) + dashboard + recherche globale.
// Toute donnée est liée à organization_id ; l'accès est toujours vérifié côté serveur.
import {
  uuid, nowIso, cleanText, isValidEmail, isValidPhone, isValidUrl,
} from "../security.js";
import { can, rank, ROLES } from "../rbac.js";
import { logAudit } from "../audit.js";
import { getAiAnalytics } from "./ai.js";
import { analyzeLead, salesCoachAnalysis } from "../ai/smart.js";
import { emitEvent } from "../automation/events.js";
import { checkLimit } from "../billing.js";
import { processEvent, cancelFollowUpsForLead, notifyUser, notifiableMembers, smartAssign } from "../automation/engine.js";
import { resolveOutcome, predictionReadiness } from "../automation/prediction.js";

/** Phase 5 (spec §21) : lead HOT sans assignation → assignation intelligente. */
function maybeAutoAssignCrm(ctx, leadId) {
  try {
    const lead = ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, ctx.org.id);
    if (!lead || lead.assigned_to) return null;
    const r = smartAssign(ctx.db, ctx.org.id, leadId);
    if (r) logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "ASSIGN_LEAD", resourceType: "lead", resourceId: leadId, metadata: { by: "smart_assignment", strategy: r.strategy, user: r.user_id } });
    return r;
  } catch { return null; }
}

/** Phase 5 : émet un événement + le traite (jamais bloquant). */
async function crmEmit(ctx, type, payload, entityType = "lead", entityId = null) {
  try {
    const ev = emitEvent(ctx.db, ctx.org.id, { type, entity_type: entityType, entity_id: entityId, lead_id: payload?.lead_id || null, payload });
    await processEvent(ctx.db, ev);
  } catch { /* non bloquant */ }
}

/** Phase 5 (spec §54) : deal clos → outcome + statut lead + arrêt séquences/follow-ups. */
async function crmDealClosed(ctx, deal, outcome) {
  try {
    if (deal.lead_id) {
      resolveOutcome(ctx.db, ctx.org.id, deal.lead_id, outcome);
      const lead = ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(deal.lead_id, ctx.org.id);
      if (lead && lead.status !== outcome) {
        ctx.db.prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?").run(outcome, nowIso(), deal.lead_id);
        await crmEmit(ctx, "LEAD_UPDATED", { lead_id: deal.lead_id, from: lead.status, to: outcome });
      }
      cancelFollowUpsForLead(ctx.db, ctx.org.id, deal.lead_id, outcome === "WON" ? "Deal gagné" : "Lead perdu");
    }
    for (const m of notifiableMembers(ctx.db, ctx.org.id)) {
      notifyUser(ctx.db, { orgId: ctx.org.id, userId: m.user_id, type: outcome === "WON" ? "HIGH_VALUE_DEAL" : "DEAL_AT_RISK", title: `Deal ${outcome === "WON" ? "gagné" : "perdu"} : ${deal.name}`, message: `${deal.value?.toLocaleString("fr-FR") ?? 0} ${deal.currency || ctx.org.currency}`, link: `/dashboard/deals/${deal.id}`, leadId: deal.lead_id || null });
    }
  } catch { /* non bloquant */ }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_RE = /^[A-Za-z0-9._-]{2,40}$/;

export const PRODUCT_TYPES = ["PRODUCT", "SERVICE"];
export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE"];
export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
export const DEAL_STAGES = ["NEW", "QUALIFICATION", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
export const LEAD_SOURCES = ["WEBSITE", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "EMAIL", "REFERRAL", "MANUAL", "ADVERTISEMENT", "OTHER"];
export const ACTIVITY_TYPES = ["CALL", "EMAIL", "MESSAGE", "MEETING", "NOTE", "STATUS_CHANGE", "FOLLOW_UP", "PURCHASE"];
export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

/* ---------- helpers de validation ---------- */
function intVal(v, { min = 0, max = 1e12 } = {}) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
function moneyVal(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
}
function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}
function orgSettings(ctx) {
  try {
    return { allow_self_assign: true, ...(ctx.org.settings ? JSON.parse(ctx.org.settings) : {}) };
  } catch {
    return { allow_self_assign: true };
  }
}
/**
 * Règles de possession : MANAGER+ gèrent tout ; SALES_AGENT ne modifie que
 * ses propres enregistrements (ou les non assignés). Suppression réservée
 * à MANAGER+ (crm:delete).
 */
function canWriteRecord(ctx, assignedTo) {
  if (!can(ctx.member.role, "crm:write")) return false;
  if (rank(ctx.member.role) >= rank("MANAGER")) return true;
  return !assignedTo || assignedTo === ctx.user.id;
}

function requireCtx(ctx, perm) {
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
  if (!can(ctx.member.role, perm)) return ctx.sendJSON(403, { error: `Permission insuffisante (${perm}).` });
  return { org: ctx.org, member: ctx.member, user: ctx.user };
}

/* ============================ CATÉGORIES ============================ */

function listCategories(ctx) {
  return ctx.db
    .prepare("SELECT * FROM categories WHERE organization_id = ? ORDER BY sort_order ASC, name ASC")
    .all(ctx.org.id);
}

async function apiCategories(ctx) {
  const { path, method, body, db } = ctx;
  if (path === "/api/categories" && method === "GET") {
    if (!requireCtx(ctx, "catalog:read")) return true;
    return ctx.sendJSON(200, { categories: listCategories(ctx) });
  }
  if (path === "/api/categories" && method === "POST") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const name = cleanText(body.name, 60);
    const description = cleanText(body.description, 300);
    if (name.length < 1) return ctx.sendJSON(400, { error: "Le nom de la catégorie est requis." });
    const dup = db.prepare("SELECT 1 FROM categories WHERE organization_id = ? AND name = ?").get(ctx.org.id, name);
    if (dup) return ctx.sendJSON(409, { error: "Cette catégorie existe déjà." });
    const now = nowIso();
    const id = uuid();
    db.prepare("INSERT INTO categories (id, organization_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, ctx.org.id, name, description || null, now, now);
    logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "CREATE_CATEGORY", resourceType: "category", resourceId: id, metadata: { name } });
    return ctx.sendJSON(201, { id, message: "Catégorie créée." });
  }
  const m = path.match(/^\/api\/categories\/([0-9a-f-]+)$/i);
  if (m) {
    if (!isUuid(m[1])) return ctx.sendJSON(404, { error: "Introuvable." });
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const row = db.prepare("SELECT * FROM categories WHERE id = ? AND organization_id = ?").get(m[1], ctx.org.id);
    if (!row) return ctx.sendJSON(404, { error: "Catégorie introuvable." });
    if (method === "PUT") {
      const name = body.name !== undefined ? cleanText(body.name, 60) : row.name;
      const description = body.description !== undefined ? cleanText(body.description, 300) : row.description;
      if (!name) return ctx.sendJSON(400, { error: "Nom invalide." });
      const dup = db.prepare("SELECT 1 FROM categories WHERE organization_id = ? AND name = ? AND id != ?").get(ctx.org.id, name, row.id);
      if (dup) return ctx.sendJSON(409, { error: "Cette catégorie existe déjà." });
      db.prepare("UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, nowIso(), row.id);
      logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "UPDATE_CATEGORY", resourceType: "category", resourceId: row.id });
      return ctx.sendJSON(200, { message: "Catégorie mise à jour." });
    }
    if (method === "DELETE") {
      db.prepare("DELETE FROM categories WHERE id = ?").run(row.id);
      logAudit(db, { organizationId: ctx.org.id, userId: ctx.user.id, action: "DELETE_CATEGORY", resourceType: "category", resourceId: row.id });
      return ctx.sendJSON(200, { message: "Catégorie supprimée (les produits associés sont conservés)." });
    }
  }
  return false;
}

/* ============================ PRODUITS ============================ */

function stockStatus(p) {
  if (p.type === "SERVICE") return "IN_STOCK";
  if (p.stock_quantity <= 0) return "OUT_OF_STOCK";
  if (p.low_stock_threshold > 0 && p.stock_quantity <= p.low_stock_threshold) return "LOW_STOCK";
  return "IN_STOCK";
}

function fetchProduct(ctx, id) {
  if (!isUuid(id)) return null;
  return ctx.db.prepare("SELECT * FROM products WHERE id = ? AND organization_id = ?").get(id, ctx.org.id);
}

function productPayload(body, existing = null) {
  const name = cleanText(body.name, 120);
  const sku = body.sku === "" ? null : cleanText(body.sku, 40);
  const type = String(body.type || "PRODUCT").toUpperCase();
  const categoryId = body.category_id ? body.category_id : null;
  const description = cleanText(body.description, 2000);
  const price = body.price === undefined ? existing?.price ?? 0 : moneyVal(body.price);
  const discountPrice = body.discount_price === "" || body.discount_price === undefined
    ? (existing ? existing.discount_price : null)
    : moneyVal(body.discount_price);
  const currency = body.currency === "" ? null : cleanText(body.currency, 3).toUpperCase();
  const stock = body.stock_quantity === undefined ? (existing?.stock_quantity ?? 0) : intVal(body.stock_quantity, { min: 0, max: 1e9 });
  const threshold = body.low_stock_threshold === undefined ? (existing?.low_stock_threshold ?? 0) : intVal(body.low_stock_threshold, { min: 0, max: 1e9 });
  const status = String(body.status || (existing?.status || "ACTIVE")).toUpperCase();

  const errors = [];
  if (!name) errors.push("Le nom est requis.");
  if (sku && !SKU_RE.test(sku)) errors.push("SKU invalide (2-40 caractères : lettres, chiffres, . _ -).");
  if (!PRODUCT_TYPES.includes(type)) errors.push("Type invalide (PRODUCT ou SERVICE).");
  if (price === null) errors.push("Prix invalide (nombre positif requis).");
  if (discountPrice !== null && (discountPrice < 0 || discountPrice > price)) errors.push("Prix promotionnel invalide (0 ≤ promo ≤ prix).");
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push("Devise invalide (3 lettres).");
  if (stock === null) errors.push("Stock invalide (entier positif requis).");
  if (threshold === null) errors.push("Seuil de stock invalide (entier positif requis).");
  if (!PRODUCT_STATUSES.includes(status)) errors.push("Statut invalide (ACTIVE ou INACTIVE).");
  return { errors, data: { name, sku, type, categoryId, description, price, discountPrice, currency, stock, threshold, status } };
}

function validateCategoryId(ctx, categoryId) {
  if (!categoryId) return null;
  if (!isUuid(categoryId)) return "Catégorie invalide.";
  const cat = ctx.db.prepare("SELECT 1 FROM categories WHERE id = ? AND organization_id = ?").get(categoryId, ctx.org.id);
  return cat ? null : "Catégorie introuvable.";
}

function insertVariants(ctx, db, productId, variants, orgId, now) {
  if (!Array.isArray(variants)) return;
  for (const v of variants) {
    if (!v || !v.name) continue;
    const vName = cleanText(v.name, 80);
    const vSku = v.sku ? cleanText(v.sku, 40) : null;
    const vPrice = moneyVal(v.price) ?? 0;
    const vStock = intVal(v.stock_quantity, { min: 0, max: 1e9 }) ?? 0;
    const vThreshold = intVal(v.low_stock_threshold, { min: 0, max: 1e9 }) ?? 0;
    let attrs = null;
    if (v.attributes) {
      try {
        const parsed = typeof v.attributes === "string" ? JSON.parse(v.attributes) : v.attributes;
        if (parsed && typeof parsed === "object") attrs = JSON.stringify(parsed);
      } catch { /* attributs ignorés si JSON invalide */ }
    }
    if (!vName) continue;
    db.prepare(
      `INSERT INTO product_variants (id, organization_id, product_id, name, sku, price, stock_quantity, low_stock_threshold, attributes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), orgId, productId, vName, vSku && SKU_RE.test(vSku) ? vSku : null, vPrice, vStock, vThreshold, attrs, now, now);
  }
}

function insertImages(ctx, db, productId, images, orgId, now) {
  if (!Array.isArray(images)) return;
  let order = 0;
  for (const img of images) {
    if (!img || !img.url) continue;
    const url = String(img.url).slice(0, 500);
    if (!isValidUrl(url)) continue;
    db.prepare("INSERT INTO product_images (id, organization_id, product_id, url, alt_text, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uuid(), orgId, productId, url, cleanText(img.alt_text, 200) || null, order++, now);
  }
}

async function apiProducts(ctx) {
  const { path, method, body, db } = ctx;
  const org = ctx.org;

  /* ---------- liste (recherche, filtres, tri, pagination) ---------- */
  if (path === "/api/products" && method === "GET") {
    if (!requireCtx(ctx, "catalog:read")) return true;
    const where = ["p.organization_id = ?"];
    const args = [org.id];
    const q = cleanText(ctx.query.q, 100);
    if (q) {
      where.push("(p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ? OR c.name LIKE ?)");
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    if (ctx.query.status && PRODUCT_STATUSES.includes(ctx.query.status.toUpperCase())) {
      where.push("p.status = ?");
      args.push(ctx.query.status.toUpperCase());
    }
    if (ctx.query.category_id && isUuid(ctx.query.category_id)) {
      where.push("p.category_id = ?");
      args.push(ctx.query.category_id);
    }
    if (ctx.query.stock) {
      const s = String(ctx.query.stock).toUpperCase();
      if (s === "IN_STOCK") where.push("p.type = 'SERVICE' OR (p.stock_quantity > 0 AND NOT (p.low_stock_threshold > 0 AND p.stock_quantity <= p.low_stock_threshold))");
      if (s === "LOW_STOCK") where.push("p.type = 'PRODUCT' AND p.low_stock_threshold > 0 AND p.stock_quantity > 0 AND p.stock_quantity <= p.low_stock_threshold");
      if (s === "OUT_OF_STOCK") where.push("p.type = 'PRODUCT' AND p.stock_quantity <= 0");
    }
    if (ctx.query.price_min !== undefined && moneyVal(ctx.query.price_min) !== null) {
      where.push("p.price >= ?");
      args.push(moneyVal(ctx.query.price_min));
    }
    if (ctx.query.price_max !== undefined && moneyVal(ctx.query.price_max) !== null) {
      where.push("p.price <= ?");
      args.push(moneyVal(ctx.query.price_max));
    }
    const sortMap = { name: "name", price: "price", stock: "stock_quantity", created: "created_at", sku: "sku" };
    const sort = sortMap[ctx.query.sort] || "created_at";
    const dir = String(ctx.query.dir).toUpperCase() === "ASC" ? "ASC" : "DESC";
    const pageSize = Math.min(Math.max(intVal(ctx.query.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(ctx.query.page, { min: 1, max: 1e6 }) || 1, 1);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db.prepare(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(" AND ")} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`
    ).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, {
      products: rows.map((p) => ({ ...p, stock_status: stockStatus(p) })),
      pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) },
    });
  }

  /* ---------- création ---------- */
  if (path === "/api/products" && method === "POST") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const { errors, data } = productPayload(body);
    if (errors.length) return ctx.sendJSON(400, { error: errors.join(" "), errors });
    const catErr = validateCategoryId(ctx, data.categoryId);
    if (catErr) return ctx.sendJSON(400, { error: catErr });
    if (data.sku) {
      const dup = db.prepare("SELECT 1 FROM products WHERE organization_id = ? AND sku = ?").get(org.id, data.sku);
      if (dup) return ctx.sendJSON(409, { error: "Ce SKU existe déjà dans votre catalogue." });
    }
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO products (id, organization_id, name, sku, type, category_id, description, price, discount_price, currency,
       stock_quantity, low_stock_threshold, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, data.name, data.sku, data.type, data.categoryId, data.description, data.price, data.discountPrice,
      data.currency ?? org.currency, data.stock, data.threshold, data.status, ctx.user.id, now, now);
    insertVariants(ctx, db, id, body.variants, org.id, now);
    insertImages(ctx, db, id, body.images, org.id, now);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_PRODUCT", resourceType: "product", resourceId: id, metadata: { name: data.name, sku: data.sku } });
    return ctx.sendJSON(201, { id, redirect: `/dashboard/products/${id}`, message: "Produit créé." });
  }

  /* ---------- import CSV : modèle / aperçu / confirmation ---------- */
  if (path === "/api/products/import/template" && method === "GET") {
    if (!requireCtx(ctx, "import:products")) return true;
    const csv = "name,sku,description,category,price,currency,stock,status\niPhone 15 128 GO,IPHONE15-128,Smartphone 128 GO,Smartphones,950000,XOF,10,ACTIVE\nService installation,INSTAL-01,Installation sur site,Services,50000,,0,ACTIVE";
    ctx.res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="produits-modele.csv"' });
    return ctx.res.end(csv);
  }
  if (path === "/api/products/import/preview" && method === "POST") {
    const sc = requireCtx(ctx, "import:products");
    if (!sc) return true;
    const rows = parseCsvRows(body.csv);
    const preview = validateImportRows(ctx, rows);
    return ctx.sendJSON(200, {
      total_rows: preview.length,
      valid_rows: preview.filter((r) => !r.errors.length).length,
      rows: preview.slice(0, 500),
    });
  }
  if (path === "/api/products/import" && method === "POST") {
    const sc = requireCtx(ctx, "import:products");
    if (!sc) return true;
    if (!Array.isArray(body.rows) || !body.rows.length) return ctx.sendJSON(400, { error: "Aucune ligne à importer." });
    const revalidated = revalidateImportRows(ctx, body.rows);
    const now = nowIso();
    let imported = 0;
    for (const r of revalidated) {
      if (r.errors.length) continue;
      db.prepare(
        `INSERT INTO products (id, organization_id, name, sku, type, category_id, description, price, discount_price, currency,
         stock_quantity, low_stock_threshold, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), org.id, r.name, r.sku, r.type, r.category_id, r.description, r.price, null, r.currency ?? org.currency,
        r.stock, 0, r.status, ctx.user.id, now, now);
      imported++;
    }
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "IMPORT_PRODUCTS", resourceType: "product", metadata: { imported, skipped: revalidated.length - imported } });
    return ctx.sendJSON(200, { imported, skipped: revalidated.length - imported, message: `${imported} produit(s) importé(s), ${revalidated.length - imported} ignoré(s).` });
  }
  if (path === "/api/products/export.csv" && method === "GET") {
    if (!requireCtx(ctx, "catalog:read")) return true;
    const rows = db.prepare("SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.organization_id = ?").all(org.id);
    const csv = ["name,sku,type,category,description,price,discount_price,currency,stock,low_stock_threshold,status",
      ...rows.map((p) => [p.name, p.sku, p.type, p.category_name, p.description, p.price, p.discount_price ?? "", p.currency ?? org.currency, p.stock_quantity, p.low_stock_threshold, p.status].map(csvEscape).join(",")),
    ].join("\n");
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "EXPORT_PRODUCTS", resourceType: "product", metadata: { count: rows.length } });
    ctx.res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="produits-export.csv"' });
    return ctx.res.end(csv);
  }

  /* ---------- détail ---------- */
  const detail = path.match(/^\/api\/products\/([0-9a-f-]+)$/i);
  if (detail) {
    const p = fetchProduct(ctx, detail[1]);
    if (!p) return ctx.sendJSON(404, { error: "Produit introuvable." });
    if (method === "GET") {
      if (!requireCtx(ctx, "catalog:read")) return true;
      const variants = db.prepare("SELECT * FROM product_variants WHERE product_id = ? AND organization_id = ? ORDER BY created_at").all(p.id, org.id);
      const images = db.prepare("SELECT * FROM product_images WHERE product_id = ? AND organization_id = ? ORDER BY sort_order").all(p.id, org.id);
      const sales = db.prepare(
        `SELECT COALESCE(SUM(dp.quantity), 0) AS quantity, COALESCE(SUM(dp.total), 0) AS revenue
         FROM deal_products dp JOIN deals d ON d.id = dp.deal_id
         WHERE dp.product_id = ? AND d.organization_id = ? AND d.stage = 'WON'`
      ).get(p.id, org.id);
      return ctx.sendJSON(200, {
        product: { ...p, stock_status: stockStatus(p) },
        variants: variants.map((v) => ({ ...v, stock_status: stockStatus(v) })),
        images,
        sales,
      });
    }
    if (method === "PUT") {
      const sc = requireCtx(ctx, "catalog:write");
      if (!sc) return true;
      const { errors, data } = productPayload(body, p);
      if (errors.length) return ctx.sendJSON(400, { error: errors.join(" "), errors });
      const catErr = validateCategoryId(ctx, data.categoryId);
      if (catErr) return ctx.sendJSON(400, { error: catErr });
      if (data.sku) {
        const dup = db.prepare("SELECT 1 FROM products WHERE organization_id = ? AND sku = ? AND id != ?").get(org.id, data.sku, p.id);
        if (dup) return ctx.sendJSON(409, { error: "Ce SKU existe déjà dans votre catalogue." });
      }
      db.prepare(
        `UPDATE products SET name = ?, sku = ?, type = ?, category_id = ?, description = ?, price = ?, discount_price = ?,
         currency = ?, stock_quantity = ?, low_stock_threshold = ?, status = ?, updated_at = ? WHERE id = ?`
      ).run(data.name, data.sku, data.type, data.categoryId, data.description, data.price, data.discountPrice,
        data.currency ?? org.currency, data.stock, data.threshold, data.status, nowIso(), p.id);
      if (Array.isArray(body.variants)) {
        db.prepare("DELETE FROM product_variants WHERE product_id = ? AND organization_id = ?").run(p.id, org.id);
        insertVariants(ctx, db, p.id, body.variants, org.id, nowIso());
      }
      if (Array.isArray(body.images)) {
        db.prepare("DELETE FROM product_images WHERE product_id = ? AND organization_id = ?").run(p.id, org.id);
        insertImages(ctx, db, p.id, body.images, org.id, nowIso());
      }
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_PRODUCT", resourceType: "product", resourceId: p.id });
      return ctx.sendJSON(200, { message: "Produit mis à jour." });
    }
    if (method === "DELETE") {
      const sc = requireCtx(ctx, "crm:delete");
      if (!sc) return true;
      db.prepare("DELETE FROM products WHERE id = ?").run(p.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "DELETE_PRODUCT", resourceType: "product", resourceId: p.id, metadata: { name: p.name } });
      return ctx.sendJSON(200, { message: "Produit supprimé." });
    }
  }

  /* ---------- duplication / archivage ---------- */
  const dup = path.match(/^\/api\/products\/([0-9a-f-]+)\/duplicate$/i);
  if (dup && method === "POST") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const p = fetchProduct(ctx, dup[1]);
    if (!p) return ctx.sendJSON(404, { error: "Produit introuvable." });
    const now = nowIso();
    const id = uuid();
    let sku = p.sku ? `${p.sku}-COPY` : null;
    if (sku && sku.length > 40) sku = null;
    db.prepare(
      `INSERT INTO products (id, organization_id, name, sku, type, category_id, description, price, discount_price, currency,
       stock_quantity, low_stock_threshold, status, created_by, created_at, updated_at)
       SELECT ?, ?, name || ' (copie)', ?, type, category_id, description, price, discount_price, currency,
       stock_quantity, low_stock_threshold, 'ACTIVE', ?, ?, ? FROM products WHERE id = ? AND organization_id = ?`
    ).run(id, org.id, sku, ctx.user.id, now, now, p.id, org.id);
    const variants = db.prepare("SELECT * FROM product_variants WHERE product_id = ?").all(p.id);
    for (const v of variants) {
      db.prepare(
        `INSERT INTO product_variants (id, organization_id, product_id, name, sku, price, stock_quantity, low_stock_threshold, attributes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid(), org.id, id, v.name, v.sku, v.price, v.stock_quantity, v.low_stock_threshold, v.attributes, now, now);
    }
    const images = db.prepare("SELECT * FROM product_images WHERE product_id = ?").all(p.id);
    for (const img of images) {
      db.prepare("INSERT INTO product_images (id, organization_id, product_id, url, alt_text, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(uuid(), org.id, id, img.url, img.alt_text, img.sort_order, now);
    }
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_PRODUCT", resourceType: "product", resourceId: id, metadata: { duplicateOf: p.id } });
    return ctx.sendJSON(201, { id, redirect: `/dashboard/products/${id}`, message: "Produit dupliqué." });
  }
  const archive = path.match(/^\/api\/products\/([0-9a-f-]+)\/archive$/i);
  if (archive && method === "POST") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const p = fetchProduct(ctx, archive[1]);
    if (!p) return ctx.sendJSON(404, { error: "Produit introuvable." });
    const newStatus = p.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    db.prepare("UPDATE products SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, nowIso(), p.id);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_PRODUCT", resourceType: "product", resourceId: p.id, metadata: { archive: newStatus } });
    return ctx.sendJSON(200, { message: newStatus === "INACTIVE" ? "Produit archivé." : "Produit réactivé." });
  }

  /* ---------- variantes ---------- */
  const vNew = path.match(/^\/api\/products\/([0-9a-f-]+)\/variants$/i);
  if (vNew && method === "POST") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const p = fetchProduct(ctx, vNew[1]);
    if (!p) return ctx.sendJSON(404, { error: "Produit introuvable." });
    const name = cleanText(body.name, 80);
    if (!name) return ctx.sendJSON(400, { error: "Le nom de la variante est requis." });
    const price = moneyVal(body.price) ?? 0;
    const stock = intVal(body.stock_quantity, { min: 0, max: 1e9 }) ?? 0;
    const threshold = intVal(body.low_stock_threshold, { min: 0, max: 1e9 }) ?? 0;
    const sku = body.sku ? cleanText(body.sku, 40) : null;
    if (sku && !SKU_RE.test(sku)) return ctx.sendJSON(400, { error: "SKU invalide." });
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO product_variants (id, organization_id, product_id, name, sku, price, stock_quantity, low_stock_threshold, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, p.id, name, sku, price, stock, threshold, now, now);
    return ctx.sendJSON(201, { id, message: "Variante ajoutée." });
  }
  const vItem = path.match(/^\/api\/variants\/([0-9a-f-]+)$/i);
  if (vItem) {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const v = isUuid(vItem[1]) ? db.prepare("SELECT * FROM product_variants WHERE id = ? AND organization_id = ?").get(vItem[1], org.id) : null;
    if (!v) return ctx.sendJSON(404, { error: "Variante introuvable." });
    if (method === "PUT") {
      const name = body.name !== undefined ? cleanText(body.name, 80) : v.name;
      const price = body.price !== undefined ? moneyVal(body.price) : v.price;
      const stock = body.stock_quantity !== undefined ? intVal(body.stock_quantity, { min: 0, max: 1e9 }) : v.stock_quantity;
      const threshold = body.low_stock_threshold !== undefined ? intVal(body.low_stock_threshold, { min: 0, max: 1e9 }) : v.low_stock_threshold;
      const sku = body.sku === "" ? null : (body.sku !== undefined ? cleanText(body.sku, 40) : v.sku);
      if (!name || price === null || stock === null || threshold === null) return ctx.sendJSON(400, { error: "Valeur invalide." });
      if (sku && !SKU_RE.test(sku)) return ctx.sendJSON(400, { error: "SKU invalide." });
      db.prepare("UPDATE product_variants SET name = ?, sku = ?, price = ?, stock_quantity = ?, low_stock_threshold = ?, updated_at = ? WHERE id = ?")
        .run(name, sku, price ?? 0, stock, threshold, nowIso(), v.id);
      return ctx.sendJSON(200, { message: "Variante mise à jour." });
    }
    if (method === "DELETE") {
      db.prepare("DELETE FROM product_variants WHERE id = ?").run(v.id);
      return ctx.sendJSON(200, { message: "Variante supprimée." });
    }
  }

  /* ---------- images ---------- */
  const imgNew = path.match(/^\/api\/products\/([0-9a-f-]+)\/images$/i);
  if (imgNew && method === "POST") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const p = fetchProduct(ctx, imgNew[1]);
    if (!p) return ctx.sendJSON(404, { error: "Produit introuvable." });
    const url = String(body.url || "").slice(0, 500);
    if (!isValidUrl(url)) return ctx.sendJSON(400, { error: "URL d'image invalide (http/https requis)." });
    const id = uuid();
    db.prepare("INSERT INTO product_images (id, organization_id, product_id, url, alt_text, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .run(id, org.id, p.id, url, cleanText(body.alt_text, 200) || null, nowIso());
    return ctx.sendJSON(201, { id, message: "Image ajoutée." });
  }
  const imgItem = path.match(/^\/api\/images\/([0-9a-f-]+)$/i);
  if (imgItem && method === "DELETE") {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const img = isUuid(imgItem[1]) ? db.prepare("SELECT * FROM product_images WHERE id = ? AND organization_id = ?").get(imgItem[1], org.id) : null;
    if (!img) return ctx.sendJSON(404, { error: "Image introuvable." });
    db.prepare("DELETE FROM product_images WHERE id = ?").run(img.id);
    return ctx.sendJSON(200, { message: "Image supprimée." });
  }

  return false;
}

/* ---------- CSV ---------- */
function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parseur CSV minimal (guillemets, virgules, retours à la ligne). */
export function parseCsvRows(csv) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  const text = String(csv || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function validateImportRows(ctx, rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const required = ["name", "sku", "description", "category", "price", "currency", "stock", "status"];
  const missing = required.filter((c) => !header.includes(c));
  const idx = {};
  for (const c of required) idx[c] = header.indexOf(c);
  const existingSkus = new Set(ctx.db.prepare("SELECT sku FROM products WHERE organization_id = ? AND sku IS NOT NULL").all(ctx.org.id).map((r) => r.sku));
  const catNames = new Map(ctx.db.prepare("SELECT id, name FROM categories WHERE organization_id = ?").all(ctx.org.id).map((r) => [r.name.toLowerCase(), r.id]));
  const seen = new Set();
  return rows.slice(1).map((cells, i) => {
    const get = (c) => (idx[c] >= 0 && cells[idx[c]] !== undefined ? String(cells[idx[c]]).trim() : "");
    const errors = missing.length ? ["Colonnes manquantes : " + missing.join(", ")] : [];
    const name = get("name");
    const sku = get("sku");
    const description = get("description");
    const category = get("category");
    const price = moneyVal(get("price"));
    const currency = get("currency").toUpperCase() || null;
    const stock = intVal(get("stock"), { min: 0, max: 1e9 });
    const status = get("status").toUpperCase() || "ACTIVE";
    if (!name) errors.push("Nom manquant");
    if (sku && !SKU_RE.test(sku)) errors.push("SKU invalide");
    if (sku && (existingSkus.has(sku) || seen.has(sku))) errors.push("Doublon SKU");
    if (price === null) errors.push("Prix invalide");
    if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push("Devise invalide");
    if (get("stock") !== "" && stock === null) errors.push("Stock invalide (entier positif)");
    if (stock === null && get("stock") === "") errors.push("Stock manquant");
    if (!PRODUCT_STATUSES.includes(status)) errors.push("Statut invalide (ACTIVE/INACTIVE)");
    if (category && !catNames.has(category.toLowerCase())) errors.push(`Catégorie inconnue : ${category}`);
    if (sku) seen.add(sku);
    return {
      line: i + 2,
      name, sku: sku || null, description: description || null,
      type: "PRODUCT",
      category_id: category ? (catNames.get(category.toLowerCase()) || null) : null,
      price: price ?? 0, currency, stock: stock ?? 0, status,
      errors,
    };
  });
}

/**
 * Re-validation côté serveur des lignes objets renvoyées par l'aperçu
 * (jamais faire confiance au client : SKU, prix, stock, catégorie re-vérifiés).
 */
function revalidateImportRows(ctx, rows) {
  const db = ctx.db;
  const orgId = ctx.org.id;
  const existingSkus = new Set(db.prepare("SELECT sku FROM products WHERE organization_id = ? AND sku IS NOT NULL").all(orgId).map((r) => r.sku));
  const catIds = new Set(db.prepare("SELECT id FROM categories WHERE organization_id = ?").all(orgId).map((r) => r.id));
  const seen = new Set();
  return rows.map((r, i) => {
    const errors = [];
    const name = cleanText(r?.name, 120);
    const sku = r?.sku ? cleanText(r.sku, 40) : null;
    const description = cleanText(r?.description, 2000) || null;
    const price = moneyVal(r?.price);
    const currency = r?.currency ? cleanText(String(r.currency), 3).toUpperCase() : null;
    const stock = intVal(r?.stock, { min: 0, max: 1e9 });
    const status = String(r?.status || "ACTIVE").toUpperCase();
    const categoryId = r?.category_id ? String(r.category_id) : null;
    if (!name) errors.push("Nom manquant");
    if (sku && !SKU_RE.test(sku)) errors.push("SKU invalide");
    if (sku && (existingSkus.has(sku) || seen.has(sku))) errors.push("Doublon SKU");
    if (price === null) errors.push("Prix invalide");
    if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push("Devise invalide");
    if (stock === null) errors.push("Stock invalide");
    if (!PRODUCT_STATUSES.includes(status)) errors.push("Statut invalide");
    if (categoryId && !catIds.has(categoryId)) errors.push("Catégorie invalide");
    if (sku) seen.add(sku);
    return {
      line: r?.line ?? i + 2,
      name, sku: sku || null, description, type: "PRODUCT",
      category_id: categoryId && catIds.has(categoryId) ? categoryId : null,
      price: price ?? 0, currency, stock: stock ?? 0, status,
      errors,
    };
  });
}

/* ============================ CLIENTS ============================ */

function customerErrors(body) {
  const e = [];
  const first = cleanText(body.first_name, 50);
  const last = cleanText(body.last_name, 50);
  const email = body.email === "" ? null : String(body.email || "").trim().toLowerCase().slice(0, 254);
  const phone = body.phone === "" ? null : cleanText(body.phone, 20);
  if (!first) e.push("Prénom requis.");
  if (!last) e.push("Nom requis.");
  if (email && !isValidEmail(email)) e.push("E-mail invalide.");
  if (phone && !isValidPhone(phone)) e.push("Téléphone invalide.");
  return { e, data: { first, last, email, phone, company: cleanText(body.company_name, 80) || null, country: cleanText(body.country, 60) || null, city: cleanText(body.city, 60) || null, notes: cleanText(body.notes, 2000) || null, source: String(body.source || "MANUAL").toUpperCase(), status: String(body.status || "ACTIVE").toUpperCase() } };
}

async function apiCustomers(ctx) {
  const { path, method, body, db } = ctx;
  const org = ctx.org;
  if (path === "/api/customers" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const where = ["organization_id = ?"];
    const args = [org.id];
    const q = cleanText(ctx.query.q, 100);
    if (q) {
      where.push("(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ? OR phone LIKE ?)");
      const like = `%${q}%`;
      args.push(like, like, like, like, like);
    }
    if (ctx.query.status && ["ACTIVE", "INACTIVE"].includes(ctx.query.status.toUpperCase())) {
      where.push("status = ?");
      args.push(ctx.query.status.toUpperCase());
    }
    const pageSize = Math.min(Math.max(intVal(ctx.query.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(ctx.query.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM customers WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, { customers: rows, pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) } });
  }
  if (path === "/api/customers" && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const { e, data } = customerErrors(body);
    if (e.length) return ctx.sendJSON(400, { error: e.join(" "), errors: e });
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, company_name, country, city, notes, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, data.first, data.last, data.email, data.phone, data.company, data.country, data.city, data.notes, data.source, data.status, now, now);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_CUSTOMER", resourceType: "customer", resourceId: id, metadata: { name: `${data.first} ${data.last}` } });
    return ctx.sendJSON(201, { id, redirect: `/dashboard/contacts/${id}`, message: "Client créé." });
  }
  const m = path.match(/^\/api\/customers\/([0-9a-f-]+)$/i);
  if (m) {
    const c = isUuid(m[1]) ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(m[1], org.id) : null;
    if (!c) return ctx.sendJSON(404, { error: "Client introuvable." });
    if (method === "GET") {
      if (!requireCtx(ctx, "crm:read")) return true;
      const leads = db.prepare("SELECT * FROM leads WHERE organization_id = ? AND (customer_id = ? OR (email IS NOT NULL AND ? != '' AND email = ?)) ORDER BY created_at DESC").all(org.id, c.id, c.email || "", c.email || "");
      const deals = db.prepare("SELECT d.*, l.name AS lead_name FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.organization_id = ? AND (d.customer_id = ? OR d.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY d.created_at DESC").all(org.id, c.id, c.id);
      const activities = db.prepare("SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND (a.customer_id = ? OR a.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY a.created_at DESC LIMIT 50").all(org.id, c.id, c.id);
      const notes = db.prepare("SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND (n.customer_id = ? OR n.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY n.created_at DESC LIMIT 50").all(org.id, c.id, c.id);
      const tasks = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND (customer_id = ? OR lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY due_date IS NULL, due_date, created_at DESC LIMIT 50").all(org.id, c.id, c.id);
      // Emplacement réservé : les conversations IA de ce client apparaîtront ici (Phase 3).
      return ctx.sendJSON(200, { customer: c, leads, deals, activities, notes, tasks, conversations: [] });
    }
    if (method === "PUT" || method === "DELETE") {
      if (method === "DELETE" && !can(ctx.member.role, "crm:delete")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:delete)." });
      const sc = requireCtx(ctx, "crm:write");
      if (!sc) return true;
      if (method === "DELETE") {
        db.prepare("DELETE FROM customers WHERE id = ?").run(c.id);
        logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "DELETE_CUSTOMER", resourceType: "customer", resourceId: c.id });
        return ctx.sendJSON(200, { message: "Client supprimé." });
      }
      const { e, data } = customerErrors({ ...body, first_name: body.first_name ?? c.first_name, last_name: body.last_name ?? c.last_name, email: body.email ?? c.email, phone: body.phone ?? c.phone });
      if (e.length) return ctx.sendJSON(400, { error: e.join(" "), errors: e });
      db.prepare(
        `UPDATE customers SET first_name = ?, last_name = ?, email = ?, phone = ?, company_name = ?, country = ?, city = ?, notes = ?, source = ?, status = ?, updated_at = ? WHERE id = ?`
      ).run(data.first, data.last, data.email, data.phone, data.company, data.country, data.city, data.notes, data.source, data.status, nowIso(), c.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_CUSTOMER", resourceType: "customer", resourceId: c.id });
      return ctx.sendJSON(200, { message: "Client mis à jour." });
    }
  }
  return false;
}

/* ============================ LEADS ============================ */

function logActivity(ctx, { customerId = null, leadId = null, dealId = null, type, description }) {
  ctx.db.prepare(
    `INSERT INTO activities (id, organization_id, customer_id, lead_id, deal_id, user_id, type, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), ctx.org.id, customerId, leadId, dealId, ctx.user.id, type, description, nowIso());
}

function fetchLead(ctx, id) {
  if (!isUuid(id)) return null;
  return ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(id, ctx.org.id);
}

function assigneeName(ctx, userId) {
  if (!userId) return null;
  const u = ctx.db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(userId);
  return u ? `${u.first_name} ${u.last_name}` : null;
}

async function apiLeads(ctx) {
  const { path, method, body, db } = ctx;
  const org = ctx.org;

  if (path === "/api/leads" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const where = ["l.organization_id = ?"];
    const args = [org.id];
    const q = cleanText(ctx.query.q, 100);
    if (q) {
      where.push("(l.name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ? OR l.phone LIKE ?)");
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    if (ctx.query.status && LEAD_STATUSES.includes(ctx.query.status.toUpperCase())) { where.push("l.status = ?"); args.push(ctx.query.status.toUpperCase()); }
    if (ctx.query.source && LEAD_SOURCES.includes(ctx.query.source.toUpperCase())) { where.push("l.source = ?"); args.push(ctx.query.source.toUpperCase()); }
    if (ctx.query.assigned_to === "me") { where.push("l.assigned_to = ?"); args.push(ctx.user.id); }
    else if (ctx.query.assigned_to && isUuid(ctx.query.assigned_to)) { where.push("l.assigned_to = ?"); args.push(ctx.query.assigned_to); }
    else if (ctx.query.assigned_to === "none") where.push("l.assigned_to IS NULL");
    if (ctx.query.min_score !== undefined && intVal(ctx.query.min_score, { min: 0, max: 100 }) !== null) { where.push("l.score >= ?"); args.push(intVal(ctx.query.min_score, { min: 0, max: 100 })); }
    if (ctx.query.date_from && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date_from)) { where.push("date(l.created_at) >= date(?)"); args.push(ctx.query.date_from); }
    if (ctx.query.date_to && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date_to)) { where.push("date(l.created_at) <= date(?)"); args.push(ctx.query.date_to); }
    const sortMap = { name: "l.name", score: "l.score", created: "l.created_at", followup: "l.next_followup_at" };
    const sort = sortMap[ctx.query.sort] || "l.created_at";
    const dir = String(ctx.query.dir).toUpperCase() === "ASC" ? "ASC" : "DESC";
    const pageSize = Math.min(Math.max(intVal(ctx.query.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(ctx.query.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db.prepare(`SELECT l.* FROM leads l WHERE ${where.join(" AND ")} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, {
      leads: rows.map((l) => ({ ...l, assigned_to_name: assigneeName(ctx, l.assigned_to) })),
      pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) },
    });
  }

  if (path === "/api/leads" && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    // Phase 8 — limite du plan (côté serveur, réponse honnête)
    const limLead = checkLimit(db, org.id, "leads");
    if (!limLead.ok) return ctx.sendJSON(403, { error: limLead.error, plan: limLead.plan, limit: limLead.limit, used: limLead.used });
    const name = cleanText(body.name, 120);
    const email = body.email === "" ? null : String(body.email || "").trim().toLowerCase().slice(0, 254);
    const phone = body.phone === "" ? null : cleanText(body.phone, 20);
    if (!name) return ctx.sendJSON(400, { error: "Le nom du lead est requis." });
    if (email && !isValidEmail(email)) return ctx.sendJSON(400, { error: "E-mail invalide." });
    if (phone && !isValidPhone(phone)) return ctx.sendJSON(400, { error: "Téléphone invalide." });
    const source = String(body.source || "MANUAL").toUpperCase();
    if (!LEAD_SOURCES.includes(source)) return ctx.sendJSON(400, { error: "Source invalide." });
    const budget = body.budget === "" || body.budget === undefined ? null : intVal(body.budget, { min: 0, max: 1e12 });
    const score = intVal(body.score, { min: 0, max: 100 });
    if (body.score !== undefined && score === null) return ctx.sendJSON(400, { error: "Score invalide (0-100)." });
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO leads (id, organization_id, customer_id, name, company_name, email, phone, source, status, interest, budget, currency, score, notes, assigned_to, last_contact_at, next_followup_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, isUuid(body.customer_id) ? body.customer_id : null, name, cleanText(body.company_name, 80) || null, email, phone, source,
      cleanText(body.interest, 300) || null, budget, cleanText(body.currency, 3).toUpperCase() || null, score ?? 0,
      cleanText(body.notes, 2000) || null, null, now, body.next_followup_at || null, now, now);
    logActivity(ctx, { leadId: id, type: "NOTE", description: "Lead créé" });
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_LEAD", resourceType: "lead", resourceId: id, metadata: { name, source } });
    await crmEmit(ctx, "LEAD_CREATED", { lead_id: id, name, source, score: score ?? 0 });
    return ctx.sendJSON(201, { id, redirect: `/dashboard/leads/${id}`, message: "Lead créé." });
  }

  // Kanban : leads groupés par statut
  if (path === "/api/leads/kanban" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const rows = db.prepare("SELECT * FROM leads WHERE organization_id = ? ORDER BY updated_at DESC").all(org.id);
    const columns = {};
    for (const s of LEAD_STATUSES) columns[s] = [];
    for (const l of rows) columns[l.status]?.push({ ...l, assigned_to_name: assigneeName(ctx, l.assigned_to) });
    return ctx.sendJSON(200, { columns });
  }

  // Déplacement kanban (changement de statut)
  const move = path.match(/^\/api\/leads\/([0-9a-f-]+)\/move$/i);
  if (move && method === "POST") {
    const lead = fetchLead(ctx, move[1]);
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    if (!canWriteRecord(ctx, lead.assigned_to)) return ctx.sendJSON(403, { error: "Vous ne pouvez pas modifier ce lead (assigné à un autre)." });
    const status = String(body.status || "").toUpperCase();
    if (!LEAD_STATUSES.includes(status)) return ctx.sendJSON(400, { error: "Statut invalide." });
    if (status === lead.status) return ctx.sendJSON(200, { message: "Statut inchangé." });
    db.prepare("UPDATE leads SET status = ?, last_contact_at = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), nowIso(), lead.id);
    logActivity(ctx, { leadId: lead.id, customerId: lead.customer_id, type: "STATUS_CHANGE", description: `Statut : ${lead.status} → ${status}` });
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CHANGE_LEAD_STATUS", resourceType: "lead", resourceId: lead.id, metadata: { from: lead.status, to: status } });
    await crmEmit(ctx, "LEAD_UPDATED", { lead_id: lead.id, from: lead.status, to: status });
    if (status === "HOT") { await crmEmit(ctx, "LEAD_BECAME_HOT", { lead_id: lead.id, from: lead.status }); maybeAutoAssignCrm(ctx, lead.id); }
    else if (lead.status === "HOT") await crmEmit(ctx, "LEAD_BECAME_COLD", { lead_id: lead.id, from: lead.status, to: status });
    if (status === "WON") { resolveOutcome(db, org.id, lead.id, "WON"); cancelFollowUpsForLead(db, org.id, lead.id, "Lead gagné"); }
    if (status === "LOST") { resolveOutcome(db, org.id, lead.id, "LOST"); cancelFollowUpsForLead(db, org.id, lead.id, "Lead perdu"); }
    return ctx.sendJSON(200, { message: `Lead déplacé vers ${status}.` });
  }

  const m = path.match(/^\/api\/leads\/([0-9a-f-]+)$/i);
  if (m) {
    const lead = fetchLead(ctx, m[1]);
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    if (method === "GET") {
      if (!requireCtx(ctx, "crm:read")) return true;
      const activities = db.prepare("SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND a.lead_id = ? ORDER BY a.created_at DESC LIMIT 50").all(org.id, lead.id);
      const notes = db.prepare("SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND n.lead_id = ? ORDER BY n.created_at DESC").all(org.id, lead.id);
      const tasks = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND lead_id = ? ORDER BY due_date IS NULL, due_date, created_at DESC").all(org.id, lead.id);
      const deals = db.prepare("SELECT * FROM deals WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC").all(org.id, lead.id);
      const customer = lead.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(lead.customer_id, org.id) : null;
      return ctx.sendJSON(200, { lead: { ...lead, assigned_to_name: assigneeName(ctx, lead.assigned_to) }, activities, notes, tasks, deals, customer });
    }
    if (method === "PUT" || method === "DELETE") {
      if (method === "DELETE" && !can(ctx.member.role, "crm:delete")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:delete)." });
      if (!canWriteRecord(ctx, lead.assigned_to)) return ctx.sendJSON(403, { error: "Vous ne pouvez pas modifier ce lead (assigné à un autre)." });
      if (method === "DELETE") {
        db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
        logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "DELETE_LEAD", resourceType: "lead", resourceId: lead.id });
        return ctx.sendJSON(200, { message: "Lead supprimé." });
      }
      const errors = [];
      const name = body.name !== undefined ? cleanText(body.name, 120) : lead.name;
      if (!name) errors.push("Nom requis.");
      const email = body.email === undefined ? lead.email : (body.email === "" ? null : String(body.email).trim().toLowerCase());
      if (email && !isValidEmail(email)) errors.push("E-mail invalide.");
      const phone = body.phone === undefined ? lead.phone : (body.phone === "" ? null : cleanText(body.phone, 20));
      if (phone && !isValidPhone(phone)) errors.push("Téléphone invalide.");
      const status = body.status !== undefined ? String(body.status).toUpperCase() : lead.status;
      if (!LEAD_STATUSES.includes(status)) errors.push("Statut invalide.");
      const source = body.source !== undefined ? String(body.source).toUpperCase() : lead.source;
      if (!LEAD_SOURCES.includes(source)) errors.push("Source invalide.");
      const budget = body.budget === undefined ? lead.budget : (body.budget === "" ? null : intVal(body.budget, { min: 0, max: 1e12 }));
      if (body.budget !== undefined && body.budget !== "" && budget === null) errors.push("Budget invalide.");
      const score = body.score === undefined ? lead.score : intVal(body.score, { min: 0, max: 100 });
      if (body.score !== undefined && score === null) errors.push("Score invalide (0-100).");
      const assignedTo = body.assigned_to === undefined ? lead.assigned_to : (body.assigned_to === "" ? null : body.assigned_to);
      if (assignedTo !== null) {
        if (!isUuid(assignedTo)) errors.push("Responsable invalide.");
        else {
          const member = db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(org.id, assignedTo);
          if (!member) errors.push("Responsable inexistant dans votre organisation.");
          else if (!["OWNER", "ADMIN", "MANAGER", "SALES_AGENT"].includes(member.role)) errors.push("Ce membre ne peut pas être responsable (rôle VIEWER).");
          else if (assignedTo !== lead.assigned_to) {
            // Règle : seul MANAGER+ peut assigner à un tiers ; SALES_AGENT seulement à lui-même (si l'org l'autorise).
            const selfAssign = assignedTo === ctx.user.id;
            const allowed = rank(ctx.member.role) >= rank("MANAGER") || (selfAssign && orgSettings(ctx).allow_self_assign);
            if (!allowed) errors.push("Vous ne pouvez pas assigner ce lead à un autre responsable.");
          }
        }
      }
      if (errors.length) return ctx.sendJSON(400, { error: errors.join(" "), errors });
      db.prepare(
        `UPDATE leads SET name = ?, company_name = ?, email = ?, phone = ?, source = ?, status = ?, interest = ?, budget = ?, currency = ?, score = ?, notes = ?, assigned_to = ?, last_contact_at = ?, next_followup_at = ?, updated_at = ? WHERE id = ?`
      ).run(name,
        body.company_name !== undefined ? (cleanText(body.company_name, 80) || null) : lead.company_name,
        email, phone, source, status,
        body.interest !== undefined ? (cleanText(body.interest, 300) || null) : lead.interest,
        budget,
        body.currency !== undefined ? (cleanText(body.currency, 3).toUpperCase() || null) : lead.currency,
        score,
        body.notes !== undefined ? (cleanText(body.notes, 2000) || null) : lead.notes,
        assignedTo,
        status !== lead.status ? nowIso() : lead.last_contact_at,
        body.next_followup_at !== undefined ? (body.next_followup_at || null) : lead.next_followup_at,
        nowIso(), lead.id);
      if (assignedTo !== lead.assigned_to) logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "ASSIGN_LEAD", resourceType: "lead", resourceId: lead.id, metadata: { from: lead.assigned_to, to: assignedTo } });
      if (status !== lead.status) {
        logActivity(ctx, { leadId: lead.id, customerId: lead.customer_id, type: "STATUS_CHANGE", description: `Statut : ${lead.status} → ${status}` });
        logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CHANGE_LEAD_STATUS", resourceType: "lead", resourceId: lead.id, metadata: { from: lead.status, to: status } });
      }
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_LEAD", resourceType: "lead", resourceId: lead.id });
      return ctx.sendJSON(200, { message: "Lead mis à jour." });
    }
  }
  return false;
}

/* ============================ DEALS ============================ */

function fetchDeal(ctx, id) {
  if (!isUuid(id)) return null;
  return ctx.db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(id, ctx.org.id);
}

async function apiDeals(ctx) {
  const { path, method, body, db } = ctx;
  const org = ctx.org;

  if (path === "/api/deals" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const where = ["d.organization_id = ?"];
    const args = [org.id];
    const q = cleanText(ctx.query.q, 100);
    if (q) { where.push("d.name LIKE ?"); args.push(`%${q}%`); }
    if (ctx.query.stage && DEAL_STAGES.includes(ctx.query.stage.toUpperCase())) { where.push("d.stage = ?"); args.push(ctx.query.stage.toUpperCase()); }
    if (ctx.query.assigned_to === "me") { where.push("d.assigned_to = ?"); args.push(ctx.user.id); }
    else if (ctx.query.assigned_to && isUuid(ctx.query.assigned_to)) { where.push("d.assigned_to = ?"); args.push(ctx.query.assigned_to); }
    if (ctx.query.min_value !== undefined && moneyVal(ctx.query.min_value) !== null) { where.push("d.value >= ?"); args.push(moneyVal(ctx.query.min_value)); }
    if (ctx.query.date_from && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date_from)) { where.push("date(d.created_at) >= date(?)"); args.push(ctx.query.date_from); }
    if (ctx.query.date_to && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date_to)) { where.push("date(d.created_at) <= date(?)"); args.push(ctx.query.date_to); }
    const pageSize = Math.min(Math.max(intVal(ctx.query.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(ctx.query.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM deals d WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db.prepare(`SELECT d.*, c.first_name || ' ' || c.last_name AS customer_name FROM deals d LEFT JOIN customers c ON c.id = d.customer_id WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, {
      deals: rows.map((d) => ({ ...d, expected_value: (d.value * d.probability) / 100, assigned_to_name: assigneeName(ctx, d.assigned_to) })),
      pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) },
    });
  }

  if (path === "/api/deals" && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const name = cleanText(body.name, 120);
    if (!name) return ctx.sendJSON(400, { error: "Le nom de l'opportunité est requis." });
    const value = moneyVal(body.value);
    if (value === null) return ctx.sendJSON(400, { error: "Valeur invalide (nombre positif)." });
    const probability = intVal(body.probability, { min: 0, max: 100 });
    if (probability === null) return ctx.sendJSON(400, { error: "Probabilité invalide (0-100)." });
    const stage = String(body.stage || "NEW").toUpperCase();
    if (!DEAL_STAGES.includes(stage)) return ctx.sendJSON(400, { error: "Étape invalide." });
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO deals (id, organization_id, customer_id, lead_id, name, description, value, currency, stage, probability, expected_close_date, assigned_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id,
      isUuid(body.customer_id) ? body.customer_id : null,
      isUuid(body.lead_id) ? body.lead_id : null,
      name, cleanText(body.description, 2000) || null, value,
      cleanText(body.currency, 3).toUpperCase() || null, stage, probability,
      body.expected_close_date || null,
      isUuid(body.assigned_to) ? body.assigned_to : null, now, now);
    logActivity(ctx, { dealId: id, customerId: isUuid(body.customer_id) ? body.customer_id : null, leadId: isUuid(body.lead_id) ? body.lead_id : null, type: "NOTE", description: "Opportunité créée" });
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_DEAL", resourceType: "deal", resourceId: id, metadata: { name, value, stage } });
    await crmEmit(ctx, "DEAL_CREATED", { lead_id: isUuid(body.lead_id) ? body.lead_id : null, name, value, stage }, "deal", id);
    await crmEmit(ctx, "QUOTE_CREATED", { lead_id: isUuid(body.lead_id) ? body.lead_id : null, name, value }, "deal", id);
    return ctx.sendJSON(201, { id, redirect: `/dashboard/deals/${id}`, message: "Opportunité créée." });
  }

  const lineNew = path.match(/^\/api\/deals\/([0-9a-f-]+)\/products$/i);
  if (lineNew && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const deal = fetchDeal(ctx, lineNew[1]);
    if (!deal) return ctx.sendJSON(404, { error: "Opportunité introuvable." });
    if (!canWriteRecord(ctx, deal.assigned_to)) return ctx.sendJSON(403, { error: "Vous ne pouvez pas modifier cette opportunité." });
    const product = isUuid(body.product_id) ? db.prepare("SELECT * FROM products WHERE id = ? AND organization_id = ?").get(body.product_id, org.id) : null;
    if (!product) return ctx.sendJSON(400, { error: "Produit introuvable." });
    const quantity = intVal(body.quantity, { min: 1, max: 1e9 });
    const unitPrice = moneyVal(body.unit_price) ?? product.discount_price ?? product.price;
    const discount = moneyVal(body.discount) ?? 0;
    if (quantity === null) return ctx.sendJSON(400, { error: "Quantité invalide (entier positif)." });
    if (unitPrice === null || discount === null) return ctx.sendJSON(400, { error: "Prix invalide." });
    const total = Math.max(quantity * unitPrice - discount, 0);
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO deal_products (id, organization_id, deal_id, product_id, quantity, unit_price, discount, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, deal.id, product.id, quantity, unitPrice, discount, total, now, now);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_DEAL", resourceType: "deal", resourceId: deal.id, metadata: { addLine: product.name } });
    return ctx.sendJSON(201, { id, total, message: "Produit ajouté à l'opportunité." });
  }
  const lineItem = path.match(/^\/api\/deal-products\/([0-9a-f-]+)$/i);
  if (lineItem) {
    const sc = requireCtx(ctx, "catalog:write");
    if (!sc) return true;
    const line = isUuid(lineItem[1]) ? db.prepare("SELECT * FROM deal_products WHERE id = ? AND organization_id = ?").get(lineItem[1], org.id) : null;
    if (!line) return ctx.sendJSON(404, { error: "Ligne introuvable." });
    const deal = fetchDeal(ctx, line.deal_id);
    if (!deal) return ctx.sendJSON(404, { error: "Opportunité introuvable." });
    if (method === "PUT") {
      const quantity = body.quantity !== undefined ? intVal(body.quantity, { min: 1, max: 1e9 }) : line.quantity;
      const unitPrice = body.unit_price !== undefined ? moneyVal(body.unit_price) : line.unit_price;
      const discount = body.discount !== undefined ? moneyVal(body.discount) : line.discount;
      if (quantity === null || unitPrice === null || discount === null) return ctx.sendJSON(400, { error: "Valeur invalide." });
      const total = Math.max(quantity * unitPrice - discount, 0);
      db.prepare("UPDATE deal_products SET quantity = ?, unit_price = ?, discount = ?, total = ?, updated_at = ? WHERE id = ?").run(quantity, unitPrice, discount, total, nowIso(), line.id);
      return ctx.sendJSON(200, { total, message: "Ligne mise à jour." });
    }
    if (method === "DELETE") {
      db.prepare("DELETE FROM deal_products WHERE id = ?").run(line.id);
      return ctx.sendJSON(200, { message: "Ligne supprimée." });
    }
  }

  const m = path.match(/^\/api\/deals\/([0-9a-f-]+)$/i);
  if (m) {
    const deal = fetchDeal(ctx, m[1]);
    if (!deal) return ctx.sendJSON(404, { error: "Opportunité introuvable." });
    if (method === "GET") {
      if (!requireCtx(ctx, "crm:read")) return true;
      const products = db.prepare(
        `SELECT dp.*, p.name AS product_name, p.sku AS product_sku FROM deal_products dp
         JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ? AND dp.organization_id = ? ORDER BY dp.created_at`
      ).all(deal.id, org.id);
      const activities = db.prepare("SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND a.deal_id = ? ORDER BY a.created_at DESC LIMIT 50").all(org.id, deal.id);
      const notes = db.prepare("SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND n.deal_id = ? ORDER BY n.created_at DESC").all(org.id, deal.id);
      const customer = deal.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(deal.customer_id, org.id) : null;
      const lead = deal.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(deal.lead_id, org.id) : null;
      return ctx.sendJSON(200, {
        deal: { ...deal, expected_value: (deal.value * deal.probability) / 100, assigned_to_name: assigneeName(ctx, deal.assigned_to) },
        products, activities, notes, customer, lead,
      });
    }
    if (method === "PUT" || method === "DELETE") {
      if (method === "DELETE" && !can(ctx.member.role, "crm:delete")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:delete)." });
      if (!canWriteRecord(ctx, deal.assigned_to)) return ctx.sendJSON(403, { error: "Vous ne pouvez pas modifier cette opportunité (assignée à un autre)." });
      if (method === "DELETE") {
        db.prepare("DELETE FROM deals WHERE id = ?").run(deal.id);
        logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "DELETE_DEAL", resourceType: "deal", resourceId: deal.id });
        return ctx.sendJSON(200, { message: "Opportunité supprimée." });
      }
      const errors = [];
      const name = body.name !== undefined ? cleanText(body.name, 120) : deal.name;
      if (!name) errors.push("Nom requis.");
      const value = body.value !== undefined ? moneyVal(body.value) : deal.value;
      if (value === null) errors.push("Valeur invalide.");
      const probability = body.probability !== undefined ? intVal(body.probability, { min: 0, max: 100 }) : deal.probability;
      if (probability === null) errors.push("Probabilité invalide (0-100).");
      const stage = body.stage !== undefined ? String(body.stage).toUpperCase() : deal.stage;
      if (!DEAL_STAGES.includes(stage)) errors.push("Étape invalide.");
      const now = nowIso();
      db.prepare(
        `UPDATE deals SET name = ?, description = ?, value = ?, currency = ?, stage = ?, probability = ?, expected_close_date = ?, assigned_to = ?, updated_at = ? WHERE id = ?`
      ).run(name,
        body.description !== undefined ? (cleanText(body.description, 2000) || null) : deal.description,
        value,
        body.currency !== undefined ? (cleanText(body.currency, 3).toUpperCase() || null) : deal.currency,
        stage, probability,
        body.expected_close_date !== undefined ? (body.expected_close_date || null) : deal.expected_close_date,
        body.assigned_to !== undefined ? (body.assigned_to === "" ? null : (isUuid(body.assigned_to) ? body.assigned_to : deal.assigned_to)) : deal.assigned_to,
        now, deal.id);
      if (errors.length) return ctx.sendJSON(400, { error: errors.join(" "), errors });
      if (stage !== deal.stage) {
        logActivity(ctx, { dealId: deal.id, leadId: deal.lead_id, customerId: deal.customer_id, type: "STATUS_CHANGE", description: `Étape deal : ${deal.stage} → ${stage}` });
        logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CHANGE_DEAL_STAGE", resourceType: "deal", resourceId: deal.id, metadata: { from: deal.stage, to: stage } });
        await crmEmit(ctx, "DEAL_STAGE_CHANGED", { lead_id: deal.lead_id || null, from: deal.stage, to: stage, value }, "deal", deal.id);
        if (stage === "PROPOSAL") await crmEmit(ctx, "QUOTE_SENT", { lead_id: deal.lead_id || null, value }, "deal", deal.id);
        if (stage === "WON") { await crmEmit(ctx, "DEAL_WON", { lead_id: deal.lead_id || null, value }, "deal", deal.id); await crmDealClosed(ctx, { ...deal, stage }, "WON"); }
        if (stage === "LOST") { await crmEmit(ctx, "DEAL_LOST", { lead_id: deal.lead_id || null, value }, "deal", deal.id); await crmDealClosed(ctx, { ...deal, stage }, "LOST"); }
      }
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_DEAL", resourceType: "deal", resourceId: deal.id });
      return ctx.sendJSON(200, { message: "Opportunité mise à jour." });
    }
  }
  return false;
}

/* ============================ ACTIVITÉS / NOTES / TÂCHES ============================ */

async function apiCrmExtras(ctx) {
  const { path, method, body, db } = ctx;
  const org = ctx.org;

  if (path === "/api/activities" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const where = ["organization_id = ?"];
    const args = [org.id];
    for (const f of ["customer_id", "lead_id", "deal_id"]) {
      if (ctx.query[f] && isUuid(ctx.query[f])) { where.push(`${f} = ?`); args.push(ctx.query[f]); }
    }
    const limit = Math.min(Math.max(intVal(ctx.query.limit, { min: 1, max: 200 }) || 50, 1), 200);
    const rows = db.prepare(
      `SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a
       LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ?`
    ).all(...args, limit);
    return ctx.sendJSON(200, { activities: rows });
  }
  if (path === "/api/activities" && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const type = String(body.type || "NOTE").toUpperCase();
    if (!ACTIVITY_TYPES.includes(type)) return ctx.sendJSON(400, { error: "Type d'activité invalide." });
    for (const f of ["customer_id", "lead_id", "deal_id"]) {
      if (body[f] && !isUuid(body[f])) return ctx.sendJSON(400, { error: `${f} invalide.` });
    }
    const id = uuid();
    db.prepare(
      `INSERT INTO activities (id, organization_id, customer_id, lead_id, deal_id, user_id, type, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, body.customer_id || null, body.lead_id || null, body.deal_id || null, ctx.user.id, type, cleanText(body.description, 500) || null, nowIso());
    return ctx.sendJSON(201, { id, message: "Activité enregistrée." });
  }

  if (path === "/api/notes" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const where = ["n.organization_id = ?"];
    const args = [org.id];
    for (const f of ["customer_id", "lead_id", "deal_id"]) {
      if (ctx.query[f] && isUuid(ctx.query[f])) { where.push(`n.${f} = ?`); args.push(ctx.query[f]); }
    }
    const rows = db.prepare(
      `SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n
       LEFT JOIN users u ON u.id = n.user_id WHERE ${where.join(" AND ")} ORDER BY n.created_at DESC LIMIT 100`
    ).all(...args);
    return ctx.sendJSON(200, { notes: rows });
  }
  if (path === "/api/notes" && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const content = cleanText(body.content, 5000);
    if (!content) return ctx.sendJSON(400, { error: "Le contenu de la note est requis." });
    for (const f of ["customer_id", "lead_id", "deal_id"]) {
      if (body[f] && !isUuid(body[f])) return ctx.sendJSON(400, { error: `${f} invalide.` });
    }
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO notes (id, organization_id, user_id, customer_id, lead_id, deal_id, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org.id, ctx.user.id, body.customer_id || null, body.lead_id || null, body.deal_id || null, content, now, now);
    return ctx.sendJSON(201, { id, message: "Note ajoutée." });
  }
  const note = path.match(/^\/api\/notes\/([0-9a-f-]+)$/i);
  if (note) {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const n = isUuid(note[1]) ? db.prepare("SELECT * FROM notes WHERE id = ? AND organization_id = ?").get(note[1], org.id) : null;
    if (!n) return ctx.sendJSON(404, { error: "Note introuvable." });
    if (method === "PUT") {
      const content = cleanText(body.content, 5000);
      if (!content) return ctx.sendJSON(400, { error: "Contenu requis." });
      db.prepare("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?").run(content, nowIso(), n.id);
      return ctx.sendJSON(200, { message: "Note modifiée." });
    }
    if (method === "DELETE") {
      db.prepare("DELETE FROM notes WHERE id = ?").run(n.id);
      return ctx.sendJSON(200, { message: "Note supprimée." });
    }
  }

  if (path === "/api/tasks" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const where = ["organization_id = ?"];
    const args = [org.id];
    if (ctx.query.status && TASK_STATUSES.includes(ctx.query.status.toUpperCase())) { where.push("status = ?"); args.push(ctx.query.status.toUpperCase()); }
    if (ctx.query.priority && TASK_PRIORITIES.includes(ctx.query.priority.toUpperCase())) { where.push("priority = ?"); args.push(ctx.query.priority.toUpperCase()); }
    if (ctx.query.assigned_to === "me") { where.push("assigned_to = ?"); args.push(ctx.user.id); }
    else if (ctx.query.assigned_to && isUuid(ctx.query.assigned_to)) { where.push("assigned_to = ?"); args.push(ctx.query.assigned_to); }
    for (const f of ["customer_id", "lead_id", "deal_id"]) {
      if (ctx.query[f] && isUuid(ctx.query[f])) { where.push(`${f} = ?`); args.push(ctx.query[f]); }
    }
    const pageSize = Math.min(Math.max(intVal(ctx.query.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(ctx.query.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY (status = 'COMPLETED' OR status = 'CANCELLED'), due_date IS NULL, due_date, created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, {
      tasks: rows.map((t) => ({ ...t, assigned_to_name: assigneeName(ctx, t.assigned_to) })),
      pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) },
    });
  }
  if (path === "/api/tasks" && method === "POST") {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const title = cleanText(body.title, 200);
    if (!title) return ctx.sendJSON(400, { error: "Le titre est requis." });
    const priority = String(body.priority || "MEDIUM").toUpperCase();
    if (!TASK_PRIORITIES.includes(priority)) return ctx.sendJSON(400, { error: "Priorité invalide." });
    const now = nowIso();
    const id = uuid();
    db.prepare(
      `INSERT INTO tasks (id, organization_id, assigned_to, customer_id, lead_id, deal_id, title, description, priority, status, due_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'TODO', ?, ?, ?, ?)`
    ).run(id, org.id,
      isUuid(body.assigned_to) ? body.assigned_to : null,
      isUuid(body.customer_id) ? body.customer_id : null,
      isUuid(body.lead_id) ? body.lead_id : null,
      isUuid(body.deal_id) ? body.deal_id : null,
      title, cleanText(body.description, 1000) || null, priority,
      body.due_date || null, ctx.user.id, now, now);
    return ctx.sendJSON(201, { id, message: "Tâche créée." });
  }
  const task = path.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  if (task) {
    const sc = requireCtx(ctx, "crm:write");
    if (!sc) return true;
    const t = isUuid(task[1]) ? db.prepare("SELECT * FROM tasks WHERE id = ? AND organization_id = ?").get(task[1], org.id) : null;
    if (!t) return ctx.sendJSON(404, { error: "Tâche introuvable." });
    if (method === "PUT") {
      const status = body.status !== undefined ? String(body.status).toUpperCase() : t.status;
      if (!TASK_STATUSES.includes(status)) return ctx.sendJSON(400, { error: "Statut invalide." });
      const priority = body.priority !== undefined ? String(body.priority).toUpperCase() : t.priority;
      if (!TASK_PRIORITIES.includes(priority)) return ctx.sendJSON(400, { error: "Priorité invalide." });
      db.prepare(
        `UPDATE tasks SET title = ?, status = ?, priority = ?, assigned_to = ?, due_date = ?, updated_at = ? WHERE id = ?`
      ).run(
        body.title !== undefined ? (cleanText(body.title, 200) || t.title) : t.title,
        status, priority,
        body.assigned_to !== undefined ? (body.assigned_to === "" ? null : (isUuid(body.assigned_to) ? body.assigned_to : t.assigned_to)) : t.assigned_to,
        body.due_date !== undefined ? (body.due_date || null) : t.due_date,
        nowIso(), t.id);
      return ctx.sendJSON(200, { message: "Tâche mise à jour." });
    }
    if (method === "DELETE") {
      if (!can(ctx.member.role, "crm:delete")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:delete)." });
      db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
      return ctx.sendJSON(200, { message: "Tâche supprimée." });
    }
  }
  return false;
}

/* ============================ DASHBOARD + RECHERCHE ============================ */

function periodRange(ctx) {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const p = ctx.query.period || "30d";
  let from = new Date(now);
  if (p === "7d") from.setDate(now.getDate() - 7);
  else if (p === "90d") from.setDate(now.getDate() - 90);
  else if (p === "year") from = new Date(now.getFullYear(), 0, 1);
  else if (p === "custom" && ctx.query.from && ctx.query.to && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.from) && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.to)) {
    from = new Date(ctx.query.from + "T00:00:00");
    const to = new Date(ctx.query.to + "T23:59:59");
    return { from, end: to, p };
  } else if (p === "30d") from.setDate(now.getDate() - 30);
  return { from, end, p };
}

function seriesByDay(db, orgId, table, dateCol, whereExtra = "", argsExtra = [], valueCol = "1") {
  const rows = db.prepare(
    `SELECT substr(${dateCol}, 1, 10) AS day, COUNT(*) AS count, COALESCE(SUM(${valueCol}), 0) AS total
     FROM ${table} WHERE organization_id = ? AND ${dateCol} >= ? ${whereExtra}
     GROUP BY day ORDER BY day`
  ).all(orgId, ...argsExtra);
  return rows;
}

async function apiDashboard(ctx) {
  const { path, method, db } = ctx;
  const org = ctx.org;

  if (path === "/api/dashboard" && method === "GET") {
    if (!requireCtx(ctx, "dashboard:read")) return true;
    const leads = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('QUALIFIED','HOT','PROPOSAL','NEGOTIATION','WON') THEN 1 ELSE 0 END) AS qualified,
              SUM(CASE WHEN status = 'HOT' THEN 1 ELSE 0 END) AS hot
       FROM leads WHERE organization_id = ?`
    ).get(org.id);
    const deals = db.prepare(
      `SELECT COUNT(*) AS open_count, COALESCE(SUM(value), 0) AS pipeline, COALESCE(SUM(value * probability / 100.0), 0) AS expected
       FROM deals WHERE organization_id = ? AND stage NOT IN ('WON','LOST')`
    ).get(org.id);
    const won = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS value FROM deals WHERE organization_id = ? AND stage = 'WON'").get(org.id);
    const totalDeals = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE organization_id = ?").get(org.id).n;

    const { from } = periodRange(ctx);
    const fromIso = from.toISOString();
    const byPeriod = (dateCol, whereExtra = "", argsExtra = [], valueCol = "1") =>
      db.prepare(
        `SELECT substr(${dateCol}, 1, 10) AS day, COUNT(*) AS count, COALESCE(SUM(${valueCol}), 0) AS total
         FROM deals WHERE organization_id = ? AND ${dateCol} >= ? ${whereExtra} GROUP BY day ORDER BY day`
      ).all(org.id, fromIso, ...argsExtra);
    const leadsByPeriod = db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM leads WHERE organization_id = ? AND created_at >= ? GROUP BY day ORDER BY day`
    ).all(org.id, fromIso);
    const dealsByPeriod = byPeriod("created_at");
    const wonByPeriod = byPeriod("updated_at", "AND stage = 'WON'", [], "value");
    const pipelineByStage = db.prepare(
      `SELECT stage, COUNT(*) AS count, COALESCE(SUM(value), 0) AS total FROM deals
       WHERE organization_id = ? AND stage NOT IN ('WON','LOST') GROUP BY stage`
    ).all(org.id);
    const sources = db.prepare("SELECT source, COUNT(*) AS count FROM leads WHERE organization_id = ? GROUP BY source ORDER BY count DESC").all(org.id);
    const topProducts = db.prepare(
      `SELECT p.name, p.id AS product_id, COALESCE(SUM(dp.quantity), 0) AS quantity, COALESCE(SUM(dp.total), 0) AS revenue
       FROM deal_products dp JOIN products p ON p.id = dp.product_id
       JOIN deals d ON d.id = dp.deal_id
       WHERE d.organization_id = ? AND d.stage = 'WON'
       GROUP BY dp.product_id ORDER BY quantity DESC LIMIT 5`
    ).all(org.id);

    return ctx.sendJSON(200, {
      currency: org.currency,
      stats: {
        total_leads: leads.total || 0,
        qualified_leads: leads.qualified || 0,
        hot_leads: leads.hot || 0,
        open_deals: deals.open_count || 0,
        won_deals: won.n || 0,
        pipeline_value: deals.pipeline || 0,
        expected_value: deals.expected || 0,
        won_value: won.value || 0,
        conversion_rate: totalDeals ? Math.round(((won.n || 0) / totalDeals) * 1000) / 10 : null,
      },
      period: { leads: leadsByPeriod, deals: dealsByPeriod, won: wonByPeriod, pipelineByStage, sources, topProducts },
    });
  }

  if (path === "/api/search" && method === "GET") {
    if (!requireCtx(ctx, "crm:read")) return true;
    const q = cleanText(ctx.query.q, 100);
    if (!q) return ctx.sendJSON(200, { query: "", groups: { products: [], customers: [], leads: [], deals: [] } });
    const like = `%${q}%`;
    const products = db.prepare("SELECT id, name, sku, price, currency FROM products WHERE organization_id = ? AND (name LIKE ? OR sku LIKE ? OR description LIKE ?) ORDER BY name LIMIT 5").all(org.id, like, like, like);
    const customers = db.prepare("SELECT id, first_name, last_name, email, company_name FROM customers WHERE organization_id = ? AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ? OR phone LIKE ?) ORDER BY first_name LIMIT 5").all(org.id, like, like, like, like, like);
    const leads = db.prepare("SELECT id, name, email, company_name, status FROM leads WHERE organization_id = ? AND (name LIKE ? OR email LIKE ? OR company_name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 5").all(org.id, like, like, like, like);
    const deals = db.prepare("SELECT id, name, value, currency, stage FROM deals WHERE organization_id = ? AND name LIKE ? ORDER BY name LIMIT 5").all(org.id, like);
    return ctx.sendJSON(200, { query: q, groups: { products, customers, leads, deals } });
  }

  return false;
}

/** Routeur principal du module CRM (appelé depuis server/index.js). */
export async function handleApi(ctx) {
  const { path } = ctx;
  if (!path.startsWith("/api/")) return false;

  const CRM_PREFIXES = [
    "/api/products", "/api/categories", "/api/customers", "/api/leads", "/api/deals",
    "/api/deal-products", "/api/tasks", "/api/notes", "/api/activities",
    "/api/dashboard", "/api/search", "/api/variants", "/api/images",
  ];
  const isCrm = CRM_PREFIXES.some((p) => path.startsWith(p));

  if (!ctx.user || !ctx.org || !ctx.member) {
    if (isCrm) return ctx.sendJSON(401, { error: "Connexion requise." });
    return false;
  }

  // Scope multi-tenant : ?organization_id=… n'est accepté que si l'utilisateur
  // EST membre de cette organisation — sinon 403 (jamais de fuite par l'ID).
  const requestedOrg = ctx.query.organization_id;
  if (requestedOrg) {
    const m = isUuid(requestedOrg)
      ? ctx.db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(requestedOrg, ctx.user.id)
      : null;
    const o = m ? ctx.db.prepare("SELECT * FROM organizations WHERE id = ?").get(requestedOrg) : null;
    if (!m || !o) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
    ctx.org = o;
    ctx.member = m;
  }

  // Convention : un sous-handler renvoie false s'il ne gère pas le chemin,
  // sinon il écrit la réponse et renvoie autre chose (undefined/true).
  const routes = [
    ["/api/categories", apiCategories],
    ["/api/deal-products", apiDeals],
    ["/api/deals", apiDeals],
    ["/api/products", apiProducts],
    ["/api/variants", apiProducts],
    ["/api/images", apiProducts],
    ["/api/customers", apiCustomers],
    ["/api/leads", apiLeads],
    ["/api/tasks", apiCrmExtras],
    ["/api/notes", apiCrmExtras],
    ["/api/activities", apiCrmExtras],
    ["/api/dashboard", apiDashboard],
    ["/api/search", apiDashboard],
  ];
  for (const [prefix, handler] of routes) {
    if (path.startsWith(prefix)) {
      const handled = await handler(ctx);
      if (handled !== false) return true;
    }
  }
  return false;
}

/* ============================ PAGES (rendering serveur) ============================ */
import {
  productsPage, productFormPage, productDetailPage, categoriesPage,
  customersPage, customerFormPage, customerDetailPage,
  leadsPage, leadFormPage, leadDetailPage, leadKanbanPage,
  dealsPage, dealFormPage, dealDetailPage,
  tasksPage, taskFormPage, searchPage, dashboardPage,
} from "../views/crm.js";

function pageCtx(ctx) {
  return { ...ctx, user: ctx.user, org: ctx.org, member: ctx.member };
}

function membersOf(ctx) {
  return ctx.db.prepare(
    `SELECT u.id, u.first_name, u.last_name, om.role FROM organization_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = ? AND om.status = 'active' ORDER BY u.first_name`
  ).all(ctx.org.id);
}

export async function handlePage(ctx) {
  const { path, method } = ctx;
  if (method !== "GET") return false;
  if (!path.startsWith("/dashboard/") && path !== "/dashboard") return false;
  if (!ctx.user) {
    ctx.redirect("/login");
    return true;
  }
  if (!ctx.org || !ctx.member) {
    ctx.redirect("/login");
    return true;
  }
  if (!ctx.org.onboarding_completed) {
    ctx.redirect("/onboarding");
    return true;
  }
  const p = ctx;
  const q = ctx.query;

  /* ---------- dashboard commercial ---------- */
  if (path === "/dashboard") {
    if (!can(ctx.member.role, "dashboard:read")) {
      ctx.sendHTML(403, "<h1>403</h1>");
      return true;
    }
    const db = ctx.db;
    const org = ctx.org;
    const leads = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('QUALIFIED','HOT','PROPOSAL','NEGOTIATION','WON') THEN 1 ELSE 0 END) AS qualified, SUM(CASE WHEN status='HOT' THEN 1 ELSE 0 END) AS hot FROM leads WHERE organization_id = ?`
    ).get(org.id);
    const deals = db.prepare(
      `SELECT COUNT(*) AS open_count, COALESCE(SUM(value),0) AS pipeline, COALESCE(SUM(value*probability/100.0),0) AS expected FROM deals WHERE organization_id = ? AND stage NOT IN ('WON','LOST')`
    ).get(org.id);
    const won = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(value),0) AS value FROM deals WHERE organization_id = ? AND stage = 'WON'").get(org.id);
    const totalDeals = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE organization_id = ?").get(org.id).n;
    const now = new Date();
    const fromP = q.period || "30d";
    let from = new Date(now);
    if (fromP === "7d") from.setDate(now.getDate() - 7);
    else if (fromP === "90d") from.setDate(now.getDate() - 90);
    else if (fromP === "year") from = new Date(now.getFullYear(), 0, 1);
    else if (fromP === "custom" && q.from && q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) from = new Date(q.from + "T00:00:00");
    else from.setDate(now.getDate() - 30);
    const fromIso = from.toISOString();
    const leadsPeriod = db.prepare("SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM leads WHERE organization_id = ? AND created_at >= ? GROUP BY day ORDER BY day").all(org.id, fromIso);
    const dealsPeriod = db.prepare("SELECT substr(created_at,1,10) AS day, COUNT(*) AS count FROM deals WHERE organization_id = ? AND created_at >= ? GROUP BY day ORDER BY day").all(org.id, fromIso);
    const wonPeriod = db.prepare("SELECT substr(updated_at,1,10) AS day, COUNT(*) AS count, COALESCE(SUM(value),0) AS total FROM deals WHERE organization_id = ? AND updated_at >= ? AND stage = 'WON' GROUP BY day ORDER BY day").all(org.id, fromIso);
    const pipelineByStage = db.prepare("SELECT stage, COUNT(*) AS count, COALESCE(SUM(value),0) AS total FROM deals WHERE organization_id = ? AND stage NOT IN ('WON','LOST') GROUP BY stage").all(org.id);
    const sources = db.prepare("SELECT source, COUNT(*) AS count FROM leads WHERE organization_id = ? GROUP BY source ORDER BY count DESC").all(org.id);
    const topProducts = db.prepare(
      `SELECT p.name, COALESCE(SUM(dp.quantity),0) AS quantity, COALESCE(SUM(dp.total),0) AS revenue
       FROM deal_products dp JOIN products p ON p.id = dp.product_id JOIN deals d ON d.id = dp.deal_id
       WHERE d.organization_id = ? AND d.stage = 'WON' GROUP BY dp.product_id ORDER BY quantity DESC LIMIT 5`
    ).all(org.id);
    const sub = db.prepare("SELECT plan FROM subscriptions WHERE organization_id = ?").get(org.id);
    // Phase 5 : cartes d'automatisation (données réelles)
    const automationsActive = db.prepare("SELECT COUNT(*) n FROM automations WHERE organization_id = ? AND status = 'ACTIVE'").get(org.id).n;
    const followupsPending = db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND status IN ('SCHEDULED','PENDING_APPROVAL')").get(org.id).n;
    const campaignsActive = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE organization_id = ? AND status = 'ACTIVE'").get(org.id).n;
    const atRisk = db.prepare("SELECT COUNT(*) n FROM leads WHERE organization_id = ? AND at_risk = 1").get(org.id).n;
    const tasksOpen = db.prepare("SELECT COUNT(*) n FROM tasks WHERE organization_id = ? AND status IN ('TODO','IN_PROGRESS')").get(org.id).n;
    const revenueAssoc = db.prepare(`
      SELECT COALESCE(SUM(d.value),0) t FROM deals d
      WHERE d.organization_id = ? AND d.stage = 'WON' AND d.lead_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM followup_history f WHERE f.organization_id = d.organization_id AND f.lead_id = d.lead_id AND f.status = 'SENT'
                   UNION SELECT 1 FROM sequence_enrollments e WHERE e.organization_id = d.organization_id AND e.lead_id = d.lead_id)`).get(org.id).t;
    const readiness = (() => { try { return predictionReadiness(db, org); } catch { return null; } })();
    return ctx.sendHTML(200, dashboardPage(pageCtx(ctx), {
      user: ctx.user, org: { ...ctx.org, _plan: sub?.plan || "FREE" },
      stats: {
        total_leads: leads.total || 0, qualified_leads: leads.qualified || 0, hot_leads: leads.hot || 0,
        open_deals: deals.open_count || 0, won_deals: won.n || 0,
        pipeline_value: deals.pipeline || 0, expected_value: deals.expected || 0,
        conversion_rate: totalDeals ? Math.round(((won.n || 0) / totalDeals) * 1000) / 10 : null,
      },
      period: { leads: leadsPeriod, deals: dealsPeriod, won: wonPeriod, pipelineByStage, sources, topProducts },
      ai: getAiAnalytics(db, org.id),
      phase5: {
        automations: automationsActive, followups: followupsPending, campaigns: campaignsActive,
        at_risk: atRisk, tasks: tasksOpen, revenue_associated: revenueAssoc || 0,
        prediction: readiness ? { label: readiness.label, status: readiness.status, mode: readiness.mode } : null,
      },
    }));
  }

  /* ---------- produits ---------- */
  if (path === "/dashboard/products") {
    if (!can(ctx.member.role, "catalog:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const where = ["p.organization_id = ?"];
    const args = [ctx.org.id];
    const sq = cleanText(q.q, 100);
    if (sq) { where.push("(p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ? OR c.name LIKE ?)"); const like = `%${sq}%`; args.push(like, like, like, like); }
    if (q.status && PRODUCT_STATUSES.includes(q.status.toUpperCase())) { where.push("p.status = ?"); args.push(q.status.toUpperCase()); }
    if (q.category_id && isUuid(q.category_id)) { where.push("p.category_id = ?"); args.push(q.category_id); }
    if (q.stock) {
      const s = String(q.stock).toUpperCase();
      if (s === "IN_STOCK") where.push("p.type = 'SERVICE' OR (p.stock_quantity > 0 AND NOT (p.low_stock_threshold > 0 AND p.stock_quantity <= p.low_stock_threshold))");
      if (s === "LOW_STOCK") where.push("p.type = 'PRODUCT' AND p.low_stock_threshold > 0 AND p.stock_quantity > 0 AND p.stock_quantity <= p.low_stock_threshold");
      if (s === "OUT_OF_STOCK") where.push("p.type = 'PRODUCT' AND p.stock_quantity <= 0");
    }
    const pm = moneyVal(q.price_min), pM = moneyVal(q.price_max);
    if (pm !== null) { where.push("p.price >= ?"); args.push(pm); }
    if (pM !== null) { where.push("p.price <= ?"); args.push(pM); }
    const sortMap = { name: "p.name", price: "p.price", stock: "p.stock_quantity", created: "p.created_at", sku: "p.sku" };
    const sort = sortMap[q.sort] || "p.created_at";
    const dir = String(q.dir).toUpperCase() === "ASC" ? "ASC" : "DESC";
    const pageSize = Math.min(Math.max(intVal(q.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(q.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = ctx.db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where.join(" AND ")} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    const categories = ctx.db.prepare("SELECT * FROM categories WHERE organization_id = ? ORDER BY name").all(ctx.org.id);
    return ctx.sendHTML(200, productsPage(pageCtx(ctx), {
      products: rows, categories, q,
      pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) },
    }));
  }
  if (path === "/dashboard/products/new") {
    if (!can(ctx.member.role, "catalog:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const categories = ctx.db.prepare("SELECT * FROM categories WHERE organization_id = ? ORDER BY name").all(ctx.org.id);
    return ctx.sendHTML(200, productFormPage(pageCtx(ctx), { product: null, categories }));
  }
  if (path === "/dashboard/products/categories") {
    if (!can(ctx.member.role, "catalog:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const categories = ctx.db.prepare("SELECT * FROM categories WHERE organization_id = ? ORDER BY sort_order, name").all(ctx.org.id);
    const counts = {};
    for (const r of ctx.db.prepare("SELECT category_id, COUNT(*) AS n FROM products WHERE organization_id = ? AND category_id IS NOT NULL GROUP BY category_id").all(ctx.org.id)) counts[r.category_id] = r.n;
    return ctx.sendHTML(200, categoriesPage(pageCtx(ctx), { categories, counts }));
  }
  const pNew = path.match(/^\/dashboard\/products\/new$/);
  const pEdit = path.match(/^\/dashboard\/products\/([0-9a-f-]+)\/edit$/i);
  const pDetail = path.match(/^\/dashboard\/products\/([0-9a-f-]+)$/i);
  if (pEdit || pDetail) {
    if (!can(ctx.member.role, "catalog:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const id = (pEdit || pDetail)[1];
    const prod = isUuid(id) ? ctx.db.prepare("SELECT * FROM products WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) : null;
    if (!prod) { ctx.sendHTML(404, "<h1>404 — Produit introuvable</h1>"); return true; }
    const categories = ctx.db.prepare("SELECT * FROM categories WHERE organization_id = ? ORDER BY name").all(ctx.org.id);
    const cat = prod.category_id ? ctx.db.prepare("SELECT name FROM categories WHERE id = ?").get(prod.category_id) : null;
    if (pEdit) {
      if (!can(ctx.member.role, "catalog:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
      const variants = ctx.db.prepare("SELECT * FROM product_variants WHERE product_id = ? AND organization_id = ?").all(prod.id, ctx.org.id);
      const images = ctx.db.prepare("SELECT * FROM product_images WHERE product_id = ? AND organization_id = ?").all(prod.id, ctx.org.id);
      return ctx.sendHTML(200, productFormPage(pageCtx(ctx), { product: { ...prod, _variants: variants, _images: images }, categories }));
    }
    const variants = ctx.db.prepare("SELECT * FROM product_variants WHERE product_id = ? AND organization_id = ? ORDER BY created_at").all(prod.id, ctx.org.id);
    const images = ctx.db.prepare("SELECT * FROM product_images WHERE product_id = ? AND organization_id = ? ORDER BY sort_order").all(prod.id, ctx.org.id);
    const sales = ctx.db.prepare(
      `SELECT COALESCE(SUM(dp.quantity),0) AS quantity, COALESCE(SUM(dp.total),0) AS revenue
       FROM deal_products dp JOIN deals d ON d.id = dp.deal_id WHERE dp.product_id = ? AND d.organization_id = ? AND d.stage = 'WON'`
    ).get(prod.id, ctx.org.id);
    return ctx.sendHTML(200, productDetailPage(pageCtx(ctx), { product: { ...prod, category_name: cat?.name || null }, variants, images, sales }));
  }

  /* ---------- clients ---------- */
  if (path === "/dashboard/contacts") {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const where = ["organization_id = ?"];
    const args = [ctx.org.id];
    const cq = cleanText(q.q, 100);
    if (cq) { where.push("(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ? OR phone LIKE ?)"); const like = `%${cq}%`; args.push(like, like, like, like, like); }
    if (q.status && ["ACTIVE", "INACTIVE"].includes(q.status.toUpperCase())) { where.push("status = ?"); args.push(q.status.toUpperCase()); }
    const pageSize = Math.min(Math.max(intVal(q.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(q.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = ctx.db.prepare(`SELECT * FROM customers WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendHTML(200, customersPage(pageCtx(ctx), { customers: rows, q, pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) } }));
  }
  if (path === "/dashboard/contacts/new") {
    if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    return ctx.sendHTML(200, customerFormPage(pageCtx(ctx), { customer: null }));
  }
  const cEdit = path.match(/^\/dashboard\/contacts\/([0-9a-f-]+)\/edit$/i);
  const cDetail = path.match(/^\/dashboard\/contacts\/([0-9a-f-]+)$/i);
  if (cEdit || cDetail) {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const id = (cEdit || cDetail)[1];
    const cust = isUuid(id) ? ctx.db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) : null;
    if (!cust) { ctx.sendHTML(404, "<h1>404 — Client introuvable</h1>"); return true; }
    if (cEdit) {
      if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
      return ctx.sendHTML(200, customerFormPage(pageCtx(ctx), { customer: cust }));
    }
    const db = ctx.db;
    const leads = db.prepare("SELECT * FROM leads WHERE organization_id = ? AND (customer_id = ? OR (email IS NOT NULL AND ? != '' AND email = ?)) ORDER BY created_at DESC").all(ctx.org.id, cust.id, cust.email || "", cust.email || "");
    const deals = db.prepare("SELECT d.*, l.name AS lead_name FROM deals d LEFT JOIN leads l ON l.id = d.lead_id WHERE d.organization_id = ? AND (d.customer_id = ? OR d.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY d.created_at DESC").all(ctx.org.id, cust.id, cust.id);
    const activities = db.prepare("SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND (a.customer_id = ? OR a.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY a.created_at DESC LIMIT 50").all(ctx.org.id, cust.id, cust.id);
    const notes = db.prepare("SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND (n.customer_id = ? OR n.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY n.created_at DESC LIMIT 50").all(ctx.org.id, cust.id, cust.id);
    const tasks = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND (customer_id = ? OR lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY due_date IS NULL, due_date, created_at DESC LIMIT 50").all(ctx.org.id, cust.id, cust.id);
    return ctx.sendHTML(200, customerDetailPage(pageCtx(ctx), { customer: cust, leads, deals, activities, notes, tasks, conversations: [] }));
  }

  /* ---------- leads ---------- */
  if (path === "/dashboard/leads") {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const where = ["l.organization_id = ?"];
    const args = [ctx.org.id];
    const lq = cleanText(q.q, 100);
    if (lq) { where.push("(l.name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ? OR l.phone LIKE ?)"); const like = `%${lq}%`; args.push(like, like, like, like); }
    if (q.status && LEAD_STATUSES.includes(q.status.toUpperCase())) { where.push("l.status = ?"); args.push(q.status.toUpperCase()); }
    if (q.source && LEAD_SOURCES.includes(q.source.toUpperCase())) { where.push("l.source = ?"); args.push(q.source.toUpperCase()); }
    if (q.assigned_to === "me") { where.push("l.assigned_to = ?"); args.push(ctx.user.id); }
    else if (q.assigned_to && isUuid(q.assigned_to)) { where.push("l.assigned_to = ?"); args.push(q.assigned_to); }
    else if (q.assigned_to === "none") where.push("l.assigned_to IS NULL");
    if (q.min_score !== undefined && intVal(q.min_score, { min: 0, max: 100 }) !== null) { where.push("l.score >= ?"); args.push(intVal(q.min_score, { min: 0, max: 100 })); }
    if (q.date_from && /^\d{4}-\d{2}-\d{2}$/.test(q.date_from)) { where.push("date(l.created_at) >= date(?)"); args.push(q.date_from); }
    if (q.date_to && /^\d{4}-\d{2}-\d{2}$/.test(q.date_to)) { where.push("date(l.created_at) <= date(?)"); args.push(q.date_to); }
    // Filtres intelligents (spec Phase 4 §31)
    const SMART_FILTERS = {
      hot: () => where.push("l.hot = 1"),
      high_intent: () => where.push("l.purchase_intent IN ('HIGH','VERY_HIGH')"),
      high_value: () => where.push("COALESCE(l.estimated_value, 0) >= 1000000"),
      no_followup: () => where.push("l.next_followup_at IS NULL"),
      no_response: () => where.push("COALESCE(l.last_contact_at, l.created_at) < datetime('now','-3 day')"),
      new: () => where.push("l.created_at >= datetime('now','-7 day')"),
      at_risk: () => where.push("l.at_risk = 1"),
      ready_to_buy: () => where.push("l.purchase_intent IN ('HIGH','VERY_HIGH') AND l.bant_budget IN ('HIGH','CONFIRMED')"),
    };
    if (q.filter && SMART_FILTERS[q.filter]) SMART_FILTERS[q.filter]();
    // Tri (spec Phase 4 §30)
    const LEAD_SORTS = {
      score: "l.score DESC",
      priority: "CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, l.score DESC",
      deal_value: "COALESCE(l.estimated_value, 0) DESC",
      date: "l.created_at DESC",
    };
    const sort = LEAD_SORTS[q.sort] || LEAD_SORTS.date;
    const pageSize = Math.min(Math.max(intVal(q.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(q.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = ctx.db.prepare(`SELECT l.* FROM leads l WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    const leadsOut = rows.map((l) => {
      const u = l.assigned_to ? ctx.db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(l.assigned_to) : null;
      const deal = ctx.db.prepare("SELECT value FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(l.id, ctx.org.id);
      return { ...l, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null, deal_value: deal?.value ?? null, last_activity: l.last_contact_at || l.updated_at };
    });
    return ctx.sendHTML(200, leadsPage(pageCtx(ctx), { leads: leadsOut, q, members: membersOf(ctx), pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) } }));
  }
  if (path === "/dashboard/leads/new") {
    if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const customers = ctx.db.prepare("SELECT * FROM customers WHERE organization_id = ? ORDER BY first_name LIMIT 200").all(ctx.org.id);
    return ctx.sendHTML(200, leadFormPage(pageCtx(ctx), { lead: null, customers, members: membersOf(ctx) }));
  }
  if (path === "/dashboard/leads/kanban") {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const rows = ctx.db.prepare("SELECT * FROM leads WHERE organization_id = ? ORDER BY updated_at DESC").all(ctx.org.id);
    const columns = {};
    for (const s of LEAD_STATUSES) columns[s] = [];
    for (const l of rows) {
      const u = l.assigned_to ? ctx.db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(l.assigned_to) : null;
      columns[l.status]?.push({ ...l, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null });
    }
    return ctx.sendHTML(200, leadKanbanPage(pageCtx(ctx), { columns }));
  }
  const lEdit = path.match(/^\/dashboard\/leads\/([0-9a-f-]+)\/edit$/i);
  const lDetail = path.match(/^\/dashboard\/leads\/([0-9a-f-]+)$/i);
  if (lEdit || lDetail) {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const id = (lEdit || lDetail)[1];
    const lead = isUuid(id) ? ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) : null;
    if (!lead) { ctx.sendHTML(404, "<h1>404 — Lead introuvable</h1>"); return true; }
    const db = ctx.db;
    if (lEdit) {
      if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
      const customers = db.prepare("SELECT * FROM customers WHERE organization_id = ? ORDER BY first_name LIMIT 200").all(ctx.org.id);
      return ctx.sendHTML(200, leadFormPage(pageCtx(ctx), { lead, customers, members: membersOf(ctx) }));
    }
    const activities = db.prepare("SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND a.lead_id = ? ORDER BY a.created_at DESC LIMIT 50").all(ctx.org.id, lead.id);
    const notes = db.prepare("SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND n.lead_id = ? ORDER BY n.created_at DESC").all(ctx.org.id, lead.id);
    const tasks = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND lead_id = ? ORDER BY due_date IS NULL, due_date, created_at DESC").all(ctx.org.id, lead.id);
    const deals = db.prepare("SELECT * FROM deals WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC").all(ctx.org.id, lead.id);
    const customer = lead.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(lead.customer_id, ctx.org.id) : null;
    const u = lead.assigned_to ? db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(lead.assigned_to) : null;
    return ctx.sendHTML(200, leadDetailPage(pageCtx(ctx), { lead: { ...lead, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null }, activities, notes, tasks, deals, customer, members: membersOf(ctx) }));
  }

  /* ---------- deals ---------- */
  if (path === "/dashboard/deals") {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const where = ["d.organization_id = ?"];
    const args = [ctx.org.id];
    const dq = cleanText(q.q, 100);
    if (dq) { where.push("d.name LIKE ?"); args.push(`%${dq}%`); }
    if (q.stage && DEAL_STAGES.includes(q.stage.toUpperCase())) { where.push("d.stage = ?"); args.push(q.stage.toUpperCase()); }
    if (q.assigned_to === "me") { where.push("d.assigned_to = ?"); args.push(ctx.user.id); }
    else if (q.assigned_to && isUuid(q.assigned_to)) { where.push("d.assigned_to = ?"); args.push(q.assigned_to); }
    const mv = moneyVal(q.min_value);
    if (mv !== null) { where.push("d.value >= ?"); args.push(mv); }
    if (q.date_from && /^\d{4}-\d{2}-\d{2}$/.test(q.date_from)) { where.push("date(d.created_at) >= date(?)"); args.push(q.date_from); }
    if (q.date_to && /^\d{4}-\d{2}-\d{2}$/.test(q.date_to)) { where.push("date(d.created_at) <= date(?)"); args.push(q.date_to); }
    const pageSize = Math.min(Math.max(intVal(q.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(q.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM deals d WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = ctx.db.prepare(`SELECT d.*, c.first_name || ' ' || c.last_name AS customer_name FROM deals d LEFT JOIN customers c ON c.id = d.customer_id WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    const dealsOut = rows.map((d) => {
      const u = d.assigned_to ? ctx.db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(d.assigned_to) : null;
      const lead = d.lead_id ? ctx.db.prepare("SELECT last_contact_at FROM leads WHERE id = ?").get(d.lead_id) : null;
      const lastActivity = lead?.last_contact_at || d.updated_at || d.created_at;
      const days = (Date.now() - new Date(lastActivity).getTime()) / 86400000;
      const openCrit = d.lead_id ? ctx.db.prepare("SELECT COUNT(*) AS n FROM objections WHERE lead_id = ? AND resolved = 0 AND severity IN ('HIGH','CRITICAL')").get(d.lead_id).n : 0;
      let risk = "LOW", riskFactors = [];
      if (days >= 7) { riskFactors.push("aucune réponse récente"); risk = "MEDIUM"; }
      if (openCrit > 0) { riskFactors.push("objection majeure ouverte"); risk = "HIGH"; }
      if (d.probability <= 30) { riskFactors.push("probabilité faible"); if (risk === "LOW") risk = "MEDIUM"; }
      if (days >= 14) risk = "HIGH";
      let health;
      if (d.stage === "WON") health = "Won";
      else if (d.stage === "LOST") health = "Lost";
      else if (days >= 10) health = "Stalled";
      else if (risk !== "LOW") health = "At Risk";
      else health = "Healthy";
      return { ...d, expected_value: (d.value * d.probability) / 100, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null, risk, risk_factors: riskFactors, health };
    });
    return ctx.sendHTML(200, dealsPage(pageCtx(ctx), { deals: dealsOut, q, members: membersOf(ctx), pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) } }));
  }
  if (path === "/dashboard/deals/new") {
    if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const customers = ctx.db.prepare("SELECT * FROM customers WHERE organization_id = ? ORDER BY first_name LIMIT 200").all(ctx.org.id);
    const leads = ctx.db.prepare("SELECT * FROM leads WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200").all(ctx.org.id);
    const products = ctx.db.prepare("SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE' ORDER BY name LIMIT 500").all(ctx.org.id);
    return ctx.sendHTML(200, dealFormPage(pageCtx(ctx), { deal: null, products, customers, leads, members: membersOf(ctx) }));
  }
  const dEdit = path.match(/^\/dashboard\/deals\/([0-9a-f-]+)\/edit$/i);
  const dDetail = path.match(/^\/dashboard\/deals\/([0-9a-f-]+)$/i);
  if (dEdit || dDetail) {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const id = (dEdit || dDetail)[1];
    const deal = isUuid(id) ? ctx.db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) : null;
    if (!deal) { ctx.sendHTML(404, "<h1>404 — Opportunité introuvable</h1>"); return true; }
    const db = ctx.db;
    if (dEdit) {
      if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
      const customers = db.prepare("SELECT * FROM customers WHERE organization_id = ? ORDER BY first_name LIMIT 200").all(ctx.org.id);
      const leads = db.prepare("SELECT * FROM leads WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200").all(ctx.org.id);
      const products = db.prepare("SELECT * FROM products WHERE organization_id = ? ORDER BY name LIMIT 500").all(ctx.org.id);
      const u = deal.assigned_to ? db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(deal.assigned_to) : null;
      return ctx.sendHTML(200, dealFormPage(pageCtx(ctx), { deal: { ...deal, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null }, products, customers, leads, members: membersOf(ctx) }));
    }
    const lines = db.prepare("SELECT dp.*, p.name AS product_name, p.sku AS product_sku FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ? AND dp.organization_id = ? ORDER BY dp.created_at").all(deal.id, ctx.org.id);
    const activities = db.prepare("SELECT a.*, u.first_name || ' ' || u.last_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND a.deal_id = ? ORDER BY a.created_at DESC LIMIT 50").all(ctx.org.id, deal.id);
    const notes = db.prepare("SELECT n.*, u.first_name || ' ' || u.last_name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND n.deal_id = ? ORDER BY n.created_at DESC").all(ctx.org.id, deal.id);
    const customer = deal.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(deal.customer_id, ctx.org.id) : null;
    const lead = deal.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(deal.lead_id, ctx.org.id) : null;
    const products = db.prepare("SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE' ORDER BY name LIMIT 500").all(ctx.org.id);
    const u = deal.assigned_to ? db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(deal.assigned_to) : null;
    const ctxWithProducts = { ...pageCtx(ctx), _products: products };
    return ctx.sendHTML(200, dealDetailPage(ctxWithProducts, { deal: { ...deal, expected_value: (deal.value * deal.probability) / 100, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null }, products: lines, activities, notes, customer, lead }));
  }

  /* ---------- tâches ---------- */
  if (path === "/dashboard/tasks") {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const where = ["organization_id = ?"];
    const args = [ctx.org.id];
    if (q.status && TASK_STATUSES.includes(q.status.toUpperCase())) { where.push("status = ?"); args.push(q.status.toUpperCase()); }
    if (q.priority && TASK_PRIORITIES.includes(q.priority.toUpperCase())) { where.push("priority = ?"); args.push(q.priority.toUpperCase()); }
    if (q.assigned_to === "me") { where.push("assigned_to = ?"); args.push(ctx.user.id); }
    else if (q.assigned_to && isUuid(q.assigned_to)) { where.push("assigned_to = ?"); args.push(q.assigned_to); }
    const pageSize = Math.min(Math.max(intVal(q.page_size, { min: 1, max: 100 }) || 20, 1), 100);
    const page = Math.max(intVal(q.page, { min: 1, max: 1e6 }) || 1, 1);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = ctx.db.prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY (status = 'COMPLETED' OR status = 'CANCELLED'), due_date IS NULL, due_date, created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    const tasksOut = rows.map((t) => { const u = t.assigned_to ? ctx.db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(t.assigned_to) : null; return { ...t, assigned_to_name: u ? `${u.first_name} ${u.last_name}` : null }; });
    return ctx.sendHTML(200, tasksPage(pageCtx(ctx), { tasks: tasksOut, q, members: membersOf(ctx), pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) } }));
  }
  if (path === "/dashboard/tasks/new") {
    if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    return ctx.sendHTML(200, taskFormPage(pageCtx(ctx), { task: null, members: membersOf(ctx) }));
  }
  const tEdit = path.match(/^\/dashboard\/tasks\/([0-9a-f-]+)\/edit$/i);
  if (tEdit) {
    if (!can(ctx.member.role, "crm:write")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const id = tEdit[1];
    const task = isUuid(id) ? ctx.db.prepare("SELECT * FROM tasks WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) : null;
    if (!task) { ctx.sendHTML(404, "<h1>404 — Tâche introuvable</h1>"); return true; }
    return ctx.sendHTML(200, taskFormPage(pageCtx(ctx), { task, members: membersOf(ctx) }));
  }

  /* ---------- recherche globale ---------- */
  if (path === "/dashboard/search") {
    if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }
    const sq = cleanText(q.q, 100);
    if (!sq) return ctx.sendHTML(200, searchPage(pageCtx(ctx), { q: "", groups: { products: [], customers: [], leads: [], deals: [] } }));
    const like = `%${sq}%`;
    const db = ctx.db;
    const groups = {
      products: db.prepare("SELECT id, name, sku, price, currency FROM products WHERE organization_id = ? AND (name LIKE ? OR sku LIKE ? OR description LIKE ?) ORDER BY name LIMIT 5").all(ctx.org.id, like, like, like),
      customers: db.prepare("SELECT id, first_name, last_name, email, company_name FROM customers WHERE organization_id = ? AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ? OR phone LIKE ?) ORDER BY first_name LIMIT 5").all(ctx.org.id, like, like, like, like, like),
      leads: db.prepare("SELECT id, name, email, company_name, status FROM leads WHERE organization_id = ? AND (name LIKE ? OR email LIKE ? OR company_name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 5").all(ctx.org.id, like, like, like, like),
      deals: db.prepare("SELECT id, name, value, currency, stage FROM deals WHERE organization_id = ? AND name LIKE ? ORDER BY name LIMIT 5").all(ctx.org.id, like),
    };
    return ctx.sendHTML(200, searchPage(pageCtx(ctx), { q: sq, groups }));
  }

  return false;
}

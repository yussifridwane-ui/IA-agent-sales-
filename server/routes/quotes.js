// server/routes/quotes.js — Phase 7 : Devis (spec §21)
// Cycle de vie : DRAFT → SENT → VIEWED → ACCEPTED / REJECTED / EXPIRED (+ CANCELLED).
// - Prix des lignes : TOUJOURS pris du catalogue (jamais un prix client).
// - Envoi RÉEL sur le meilleur canal (e-mail connecté, sinon conversation
//   webchat) ; sans canal → échec honnête, le devis reste DRAFT.
// - Lien public /quote/<access_token> : le client accepte/rejette SANS compte.
//   Le token est un UUID (pas l'ID interne) ; contenu masqué si DRAFT/EXPIRED.
// - PDF professionnel (zéro dépendance, server/pdf.js).
import { randomUUID } from "node:crypto";
import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import { createRateLimiter, esc } from "../security.js";
import { bestChannelForLead, sendOnChannel, getConnection } from "../channels/index.js";
import { emitEvent } from "../automation/events.js";
import { notifyUser, notifiableMembers } from "../automation/engine.js";
import { buildPdf } from "../pdf.js";
import { publicQuotePage } from "../views/public-quote.js";
import { quotesPage, quoteDetailPage } from "../views/commerce.js";

const nowIso = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const QUOTE_STATUSES = ["DRAFT", "SENT", "VIEWED", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"];
const decisionRate = createRateLimiter();

function fire(db, orgId, type, entity, leadId = null, payload = null) {
  try { emitEvent(db, orgId, { type, entity_type: entity, entity_id: typeof entity === "object" ? null : entity, lead_id: leadId, payload }); } catch { /* non bloquant */ }
}

function quoteNumber(db, orgId, year, offset = 0) {
  const n = db.prepare("SELECT COUNT(*) n FROM quotes WHERE organization_id = ? AND number LIKE ?").get(orgId, `DEV-${year}-%`).n + 1 + offset;
  return `DEV-${year}-${String(n).padStart(4, "0")}`;
}

function quoteById(db, orgId, id) {
  return isUuid(id) ? (db.prepare("SELECT * FROM quotes WHERE id = ? AND organization_id = ?").get(id, orgId) || null) : null;
}

function quoteItems(db, quoteId) {
  return db.prepare("SELECT * FROM quote_items WHERE quote_id = ? ORDER BY rowid").all(quoteId);
}

function recalcTotals(db, quote) {
  const items = quoteItems(db, quote.id);
  const subtotal = Math.round(items.reduce((s, it) => s + it.total, 0) * 100) / 100;
  const total = Math.max(0, Math.round((subtotal - (quote.discount || 0) + (quote.tax || 0)) * 100) / 100);
  db.prepare("UPDATE quotes SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?").run(subtotal, total, nowIso(), quote.id);
  return { subtotal, total };
}

/** Expiration paresseuse (à chaque lecture) + événement. */
function maybeExpire(db, orgId, q) {
  if (!q) return q;
  if (["SENT", "VIEWED"].includes(q.status) && q.valid_until && q.valid_until < nowIso()) {
    db.prepare("UPDATE quotes SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(nowIso(), q.id);
    fire(db, orgId, "QUOTE_EXPIRED", "quote", q.lead_id, { quote_id: q.id, number: q.number });
    return { ...q, status: "EXPIRED" };
  }
  return q;
}

function customerOf(db, orgId, q) {
  if (q.customer_id) return db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(q.customer_id, orgId) || null;
  return null;
}

/** Contexte org + devise pour l'affichage. */
function orgCtx(db, orgId) {
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  return { org, currency: org?.currency || "XOF" };
}

/* ---------- Lignes : création validée (prix du catalogue) ---------- */
function buildItems(db, orgId, quoteId, rawItems, createdBy) {
  // Nettoie l'ancienne liste (uniquement en DRAFT — garanti par l'appelant)
  db.prepare("DELETE FROM quote_items WHERE quote_id = ?").run(quoteId);
  const lines = Array.isArray(rawItems) ? rawItems : [];
  if (!lines.length) return false;
  let ok = true;
  for (const it of lines.slice(0, 50)) {
    const quantity = Math.max(1, Math.min(10000, Math.trunc(Number(it.quantity) || 1)));
    let name = String(it.name || "").slice(0, 200);
    let unitPrice = null;
    let productId = null;
    if (it.product_id && isUuid(it.product_id)) {
      const p = db.prepare("SELECT * FROM products WHERE id = ? AND organization_id = ?").get(it.product_id, orgId);
      if (p) {
        productId = p.id;
        name = p.name;
        unitPrice = Number(p.discount_price ?? p.price) || 0; // JAMAIS le prix fourni par le client
      }
    }
    if (unitPrice == null) {
      // Ligne sans produit (service / autre) : prix saisi par l'org (borné ≥ 0)
      const v = Number(it.unit_price);
      if (!Number.isFinite(v) || v < 0 || v > 1e9) { ok = false; continue; }
      unitPrice = v;
      if (!name) name = "Prestation";
    }
    if (!name) { ok = false; continue; }
    const lineDiscount = Math.max(0, Math.min(Number(it.line_discount) || 0, quantity * unitPrice));
    const total = Math.max(0, quantity * unitPrice - lineDiscount);
    db.prepare(
      "INSERT INTO quote_items (id, organization_id, quote_id, product_id, name, quantity, unit_price, discount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(randomUUID(), orgId, quoteId, productId, name.slice(0, 200), quantity, unitPrice, lineDiscount, total);
  }
  return ok;
}

async function sendQuote(db, orgId, q, userId, origin) {
  const { currency } = orgCtx(db, orgId);
  const items = quoteItems(db, q.id);
  const customer = customerOf(db, orgId, q);
  const lead = q.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(q.lead_id, orgId) : null;
  const toEmail = customer?.email || lead?.email || null;
  const link = `${origin}/quote/${q.access_token}`;
  const summary =
    `Devis ${q.number} — ${db.prepare("SELECT name FROM organizations WHERE id = ?").get(orgId)?.name || ""}\n` +
    items.map((it, i) => `${i + 1}. ${it.name} × ${it.quantity} à ${it.unit_price} ${currency} = ${it.total} ${currency}`).join("\n") +
    `\nSous-total : ${q.subtotal} ${currency}${q.discount ? `\nRemise : -${q.discount} ${currency}` : ""}\nTOTAL : ${q.total} ${currency}\n` +
    (q.valid_until ? `Valable jusqu'au ${q.valid_until.slice(0, 10)}.\n` : "") +
    `Acceptez ou refusez ce devis en ligne : ${link}`;

  // 1) E-mail (canal CONNECTED + adresse disponible)
  const emailConn = getConnection(db, orgId, "EMAIL");
  if (emailConn?.status === "CONNECTED" && toEmail) {
    const r = await sendOnChannel(db, { orgId, channel: "EMAIL", lead: lead || { id: null }, to: toEmail, subject: `Devis ${q.number}`, text: summary });
    if (r.status === "sent") {
      db.prepare("UPDATE quotes SET status = 'SENT', sent_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), q.id);
      fire(db, orgId, "QUOTE_SENT", "quote", lead?.id || null, { quote_id: q.id, number: q.number, channel: "EMAIL" });
      logAudit(db, { organizationId: orgId, userId, action: "SEND_QUOTE", resourceType: "quote", resourceId: q.id, metadata: { number: q.number, channel: "EMAIL" } });
      return { status: "sent", channel: "EMAIL", error: null };
    }
    return { status: "failed", error: r.error || "Échec de l'envoi e-mail." };
  }
  // 2) Conversation webchat du lead (si elle existe)
  const conv = lead ? db.prepare("SELECT id FROM conversations WHERE lead_id = ? AND organization_id = ? AND channel = 'WEBCHAT' AND status IN ('ACTIVE','HANDOFF') ORDER BY updated_at DESC LIMIT 1").get(lead.id, orgId) : null;
  if (conv) {
    const r = await sendOnChannel(db, { orgId, channel: "WEBCHAT", lead, text: summary });
    if (r.status === "sent") {
      db.prepare("UPDATE quotes SET status = 'SENT', sent_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), q.id);
      fire(db, orgId, "QUOTE_SENT", "quote", lead?.id || null, { quote_id: q.id, number: q.number, channel: "WEBCHAT" });
      logAudit(db, { organizationId: orgId, userId, action: "SEND_QUOTE", resourceType: "quote", resourceId: q.id, metadata: { number: q.number, channel: "WEBCHAT" } });
      return { status: "sent", channel: "WEBCHAT", error: null };
    }
    return { status: "failed", error: r.error || "Échec de l'envoi webchat." };
  }
  // 3) Aucun canal : échec HONNÊTE (jamais de « envoyé » factice)
  return { status: "failed", error: "Canal de diffusion non configuré (connectez un e-mail SMTP, ou contactez le lead via le webchat)." };
}

function quotePdf(db, q) {
  const { org, currency } = orgCtx(db, orgIdOf(q));
  const items = quoteItems(db, q.id);
  const customer = customerOf(db, orgIdOf(q), q);
  const lines = [
    { text: "DEVIS", size: 22, bold: true, gap: 6 },
    { text: q.number, size: 14, bold: true, gap: 4 },
    { text: `Émis le ${q.created_at.slice(0, 10)}${q.valid_until ? `  ·  Valable jusqu'au ${q.valid_until.slice(0, 10)}` : ""}`, size: 9, color: [0.4, 0.4, 0.4], gap: 14 },
    { text: org?.name || "", size: 11, bold: true, gap: 10 },
    { text: "Pour :", size: 9, color: [0.4, 0.4, 0.4] },
    { text: customer ? [customer.first_name, customer.last_name].filter(Boolean).join(" ") : (q.lead_id ? "Prospect" : "—"), size: 11, bold: true },
    ...(customer?.email ? [{ text: customer.email, size: 9, color: [0.4, 0.4, 0.4] }] : []),
    { text: " ", size: 10, gap: 12 },
    { text: "Désignation", size: 10, bold: true, x: M(0) },
    { text: "Qté", size: 10, bold: true, x: M(250) },
    { text: "P.U.", size: 10, bold: true, x: M(310) },
    { text: "Total", size: 10, bold: true, x: M(430) },
    { text: " ", size: 6, gap: 6 },
  ];
  for (const it of items) {
    lines.push({ text: it.name.slice(0, 40), size: 10, x: M(0) });
    lines.push({ text: String(it.quantity), size: 10, x: M(250) });
    lines.push({ text: `${it.unit_price} ${currency}`, size: 10, x: M(310) });
    lines.push({ text: `${it.total} ${currency}`, size: 10, x: M(430) });
    lines.push({ text: " ", size: 6, gap: 4 });
  }
  lines.push(
    { text: `Sous-total : ${q.subtotal} ${currency}`, size: 10, x: M(310), gap: 8 },
    { text: `Remise : -${q.discount} ${currency}`, size: 10, x: M(310) },
    { text: `TOTAL : ${q.total} ${currency}`, size: 13, bold: true, x: M(310), gap: 10 },
    { text: " ", size: 10, gap: 20 },
    { text: "Mode de paiement : à convenir (espèces, mobile money, virement).", size: 9, color: [0.4, 0.4, 0.4] },
    { text: q.notes ? `Notes : ${q.notes}` : " ", size: 9, color: [0.4, 0.4, 0.4], gap: 8 },
  );
  function M(x) { return 48 + x; }
  return buildPdf(lines);
}

/* ---------- Routes API (authentifiées) ---------- */
export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  const api = path.match(/^\/api\/quotes(\/[0-9a-f-]+(\/[a-z-]+)?)?$/i);
  if (!api) return false;
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
  const read = can(ctx.member.role, "crm:read");
  const write = can(ctx.member.role, "crm:write");
  const orgId = ctx.org.id;
  const { currency } = orgCtx(db, orgId);

  /* Liste */
  if (method === "GET" && !api[1]) {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
    const status = String(ctx.query.status || "").toUpperCase();
    const sql = status && QUOTE_STATUSES.includes(status)
      ? "SELECT * FROM quotes WHERE organization_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200"
      : "SELECT * FROM quotes WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200";
    const rows = status ? db.prepare(sql).all(orgId, status) : db.prepare(sql).all(orgId);
    return ctx.sendJSON(200, {
      quotes: rows.map((q) => maybeExpire(db, orgId, q)),
      statuses: QUOTE_STATUSES,
      currency,
    });
  }

  /* Création (DRAFT) */
  if (method === "POST" && !api[1]) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const customer = body.customer_id && isUuid(body.customer_id) ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(body.customer_id, orgId) : null;
    if (body.customer_id && !customer) return ctx.sendJSON(400, { error: "Client inconnu." });
    const lead = body.lead_id && isUuid(body.lead_id) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(body.lead_id, orgId) : null;
    if (body.lead_id && !lead) return ctx.sendJSON(400, { error: "Lead inconnu." });
    const deal = body.deal_id && isUuid(body.deal_id) ? db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(body.deal_id, orgId) : null;
    if (body.deal_id && !deal) return ctx.sendJSON(400, { error: "Deal inconnu." });
    const year = new Date().getFullYear();
    const id = randomUUID();
    let q;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        db.prepare(
          `INSERT INTO quotes (id, organization_id, number, customer_id, lead_id, deal_id, status, currency, notes, access_token, valid_until, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, orgId, quoteNumber(db, orgId, year, attempt), customer?.id || lead?.customer_id || null, lead?.id || null, deal?.id || null,
          body.currency ? String(body.currency).slice(0, 8) : null,
          body.notes ? String(body.notes).slice(0, 2000) : null,
          randomUUID(),
          body.valid_until && !isNaN(Date.parse(body.valid_until)) ? new Date(Date.parse(body.valid_until)).toISOString() : null,
          ctx.user.id, nowIso(), nowIso());
        q = db.prepare("SELECT * FROM quotes WHERE id = ?").get(id);
        break;
      } catch (e) {
        if (String(e.message).includes("UNIQUE")) continue; // collision de numéro (parallèle) → réessayer
        throw e;
      }
    }
    if (!q) return ctx.sendJSON(500, { error: "Génération du numéro de devis impossible." });
    if (!buildItems(db, orgId, id, body.items, ctx.user.id)) {
      db.prepare("DELETE FROM quotes WHERE id = ?").run(id);
      return ctx.sendJSON(400, { error: "Lignes de devis invalides (au moins une ligne avec prix valide requise)." });
    }
    recalcTotals(db, q);
    fire(db, orgId, "QUOTE_CREATED", "quote", lead?.id || null, { quote_id: id, number: q.number });
    logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "CREATE_QUOTE", resourceType: "quote", resourceId: id, metadata: { number: q.number } });
    const fresh = db.prepare("SELECT * FROM quotes WHERE id = ?").get(id);
    return ctx.sendJSON(201, { quote: { ...fresh, items: quoteItems(db, id) } });
  }

  /* Détail */
  const segs = api[1] ? api[1].split("/").filter(Boolean) : [];
  const idPart = segs[0] || null;
  if (idPart) {
    const q = maybeExpire(db, orgId, quoteById(db, orgId, idPart));
    if (!q) return ctx.sendJSON(404, { error: "Devis introuvable." });

    if (method === "GET" && segs.length === 1) {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
      const customer = customerOf(db, orgId, q);
      const lead = q.lead_id ? db.prepare("SELECT id, name, score, status FROM leads WHERE id = ? AND organization_id = ?").get(q.lead_id, orgId) : null;
      const deal = q.deal_id ? db.prepare("SELECT id, name, value, stage FROM deals WHERE id = ? AND organization_id = ?").get(q.deal_id, orgId) : null;
      return ctx.sendJSON(200, {
        quote: { ...q, currency: q.currency || currency, items: quoteItems(db, q.id) },
        customer, lead, deal,
      });
    }

    /* Mise à jour (DRAFT uniquement) */
    if (method === "PUT") {
      if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
      if (q.status !== "DRAFT") return ctx.sendJSON(409, { error: "Seul un devis DRAFT peut être modifié." });
      if (body.items !== undefined && !buildItems(db, orgId, q.id, body.items, ctx.user.id)) {
        return ctx.sendJSON(400, { error: "Lignes de devis invalides." });
      }
      const sets = [];
      const params = [];
      if (body.notes !== undefined) { sets.push("notes = ?"); params.push(body.notes ? String(body.notes).slice(0, 2000) : null); }
      if (body.discount !== undefined) { const d = Math.max(0, Number(body.discount) || 0); sets.push("discount = ?"); params.push(d); }
      if (body.valid_until !== undefined) { sets.push("valid_until = ?"); params.push(body.valid_until && !isNaN(Date.parse(body.valid_until)) ? new Date(Date.parse(body.valid_until)).toISOString() : null); }
      if (sets.length) { sets.push("updated_at = ?"); params.push(nowIso(), q.id); db.prepare(`UPDATE quotes SET ${sets.join(", ")} WHERE id = ?`).run(...params); }
      const fresh = maybeExpire(db, orgId, db.prepare("SELECT * FROM quotes WHERE id = ?").get(q.id));
      recalcTotals(db, fresh);
      const finalQ = db.prepare("SELECT * FROM quotes WHERE id = ?").get(q.id);
      return ctx.sendJSON(200, { quote: { ...finalQ, items: quoteItems(db, q.id) } });
    }

    /* Suppression (DRAFT uniquement) */
    if (method === "DELETE") {
      if (!can(ctx.member.role, "crm:delete")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:delete)." });
      if (q.status !== "DRAFT") return ctx.sendJSON(409, { error: "Seul un devis DRAFT peut être supprimé." });
      db.prepare("DELETE FROM quotes WHERE id = ?").run(q.id);
      logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "DELETE_QUOTE", resourceType: "quote", resourceId: q.id, metadata: { number: q.number } });
      return ctx.sendJSON(200, { message: "Devis supprimé." });
    }

    const sub = segs[1] || null;

    /* Envoi réel */
    if (method === "POST" && sub === "send") {
      if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
      if (!["DRAFT", "CANCELLED"].includes(q.status)) return ctx.sendJSON(409, { error: `Un devis ${q.status} ne peut pas être (ré)envoyé.` });
      if (q.status === "CANCELLED") { db.prepare("UPDATE quotes SET status = 'DRAFT', updated_at = ? WHERE id = ?").run(nowIso(), q.id); }
      const fresh = db.prepare("SELECT * FROM quotes WHERE id = ?").get(q.id);
      if (!quoteItems(db, q.id).length) return ctx.sendJSON(400, { error: "Devis vide : ajoutez au moins une ligne." });
      if (!fresh.valid_until) {
        const vu = new Date(Date.now() + 30 * 86400e3).toISOString();
        db.prepare("UPDATE quotes SET valid_until = ? WHERE id = ?").run(vu, q.id);
        fresh.valid_until = vu;
      }
      const origin = `${ctx.secure ? "https" : "http"}://${ctx.req?.headers?.host || ""}`;
      const r = await sendQuote(db, orgId, fresh, ctx.user.id, origin);
      if (r.status === "failed") return ctx.sendJSON(200, { status: "failed", error: r.error, message: "Envoi impossible — devis conservé en brouillon (jamais d'envoi simulé)." });
      const sent = db.prepare("SELECT * FROM quotes WHERE id = ?").get(q.id);
      return ctx.sendJSON(200, { status: "sent", channel: r.channel, quote: { ...sent, items: quoteItems(db, q.id) } });
    }

    /* Annulation */
    if (method === "POST" && sub === "cancel") {
      if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
      if (!["DRAFT", "SENT", "VIEWED"].includes(q.status)) return ctx.sendJSON(409, { error: `Un devis ${q.status} ne peut pas être annulé.` });
      db.prepare("UPDATE quotes SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(nowIso(), q.id);
      logAudit(db, { organizationId: orgId, userId: ctx.user.id, action: "CANCEL_QUOTE", resourceType: "quote", resourceId: q.id, metadata: { number: q.number } });
      return ctx.sendJSON(200, { message: "Devis annulé." });
    }

    /* PDF */
    if (method === "GET" && sub === "pdf") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });
      const pdf = quotePdf(db, q);
      ctx.res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${q.number}.pdf"`, "Content-Length": pdf.length });
      return ctx.res.end(pdf);
    }
  }
  return false;
}

function orgIdOf(q) { return q.organization_id; }

/* ---------- Page publique /quote/<token> (le client n'a pas de compte) ---------- */
async function handlePublicQuotePage(ctx) {
  const { path } = ctx;
  const m = path.match(/^\/quote\/([a-zA-Z0-9_-]+)$/);
  if (!m) return false;
  if (ctx.method === "POST") return handleDecision(ctx, m[1]);
  // GET : visualisation
  const db = ctx.db;
  const q = db.prepare("SELECT * FROM quotes WHERE access_token = ?").get(m[1]);
  if (!q) {
    return ctx.sendHTML(404, `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><title>Devis introuvable</title><link rel="stylesheet" href="/style.css"/></head>
    <body class="auth-page"><div class="auth-card"><h1>Devis introuvable</h1><p class="muted">Ce lien est invalide ou n'existe plus.</p></div></body></html>`);
  }
  const orgId = q.organization_id;
  const fresh = maybeExpire(db, orgId, q);
  if (fresh.status === "DRAFT") {
    return ctx.sendHTML(200, publicQuotePage({ q: fresh, state: "draft" }));
  }
  if (fresh.status === "VIEWED") {
    // premier accès déjà marqué ; on renvoie la page
  } else if (fresh.status === "SENT") {
    db.prepare("UPDATE quotes SET status = 'VIEWED', viewed_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), q.id);
    fire(db, orgId, "QUOTE_VIEWED", "quote", q.lead_id, { quote_id: q.id, number: q.number });
    fresh.status = "VIEWED";
  }
  const items = quoteItems(db, q.id);
  const { org, currency } = orgCtx(db, orgId);
  const customer = customerOf(db, orgId, q);
  return ctx.sendHTML(200, publicQuotePage({
    q: fresh, state: fresh.status === "EXPIRED" ? "expired" : fresh.status === "ACCEPTED" ? "accepted" : fresh.status === "REJECTED" ? "rejected" : "open",
    org, currency, customer, items,
  }));
}

/* ---------- Décision publique (accepter / rejeter) ---------- */
async function handleDecision(ctx, token) {
  const db = ctx.db;
  const q = db.prepare("SELECT * FROM quotes WHERE access_token = ?").get(token);
  if (!q) return ctx.sendJSON(404, { error: "Devis introuvable." });
  const fresh = maybeExpire(db, q.organization_id, q);
  if (!["SENT", "VIEWED"].includes(fresh.status)) {
    return ctx.sendJSON(409, { error: fresh.status === "EXPIRED" ? "Ce devis a expiré." : `Ce devis ne peut plus être traité (statut ${fresh.status}).` });
  }
  // Anti-abus : borné par token
  if (!decisionRate(`quote:decision:${token}`, 20, 3600e3)) {
    return ctx.sendJSON(429, { error: "Trop de requêtes — réessayez plus tard." });
  }
  const decision = String(ctx.body?.decision || "").toLowerCase();
  if (!["accept", "reject"].includes(decision)) return ctx.sendJSON(400, { error: "decision requise (accept | reject)." });
  const orgId = fresh.organization_id;
  const reason = ctx.body?.reason ? String(ctx.body.reason).slice(0, 500) : null;
  const t = nowIso();

  if (decision === "reject") {
    db.prepare("UPDATE quotes SET status = 'REJECTED', decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?").run(t, reason, t, q.id);
    fire(db, orgId, "QUOTE_REJECTED", "quote", fresh.lead_id, { quote_id: q.id, number: fresh.number, reason });
    logAudit(db, { organizationId: orgId, userId: null, action: "QUOTE_REJECTED", resourceType: "quote", resourceId: q.id, metadata: { number: fresh.number, by: "customer" } });
    for (const m of notifiableMembers(db, orgId)) {
      notifyUser(db, { orgId, userId: m.user_id, type: "QUOTE_REJECTED", title: `Devis ${fresh.number} refusé`, message: reason || null, link: `/dashboard/quotes/${q.id}` });
    }
    return ctx.sendJSON(200, { message: "Devis refusé. Nous en prenons bonne note et reviendrons vers vous." });
  }

  /* Acceptation : deal créé (ou mis à jour) — jamais de valeur inventée */
  const { currency } = orgCtx(db, orgId);
  const customer = customerOf(db, orgId, fresh);
  const lead = fresh.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(fresh.lead_id, orgId) : null;
  let deal = fresh.deal_id ? db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(fresh.deal_id, orgId) : null;
  if (!deal && (customer || lead)) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO deals (id, organization_id, customer_id, lead_id, name, value, currency, stage, probability, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PROPOSAL', 80, ?, ?)`
    ).run(id, orgId, customer?.id || null, lead?.id || null, `Commande ${fresh.number}`, fresh.total, fresh.currency || currency, t, t);
    deal = db.prepare("SELECT * FROM deals WHERE id = ?").get(id);
  } else if (deal) {
    db.prepare("UPDATE deals SET value = ?, probability = MAX(COALESCE(probability, 0), 80), updated_at = ? WHERE id = ?").run(fresh.total, t, deal.id);
  }
  db.prepare("UPDATE quotes SET status = 'ACCEPTED', deal_id = ?, decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?")
    .run(deal?.id || null, t, reason, t, q.id);
  fire(db, orgId, "QUOTE_ACCEPTED", "quote", lead?.id || null, { quote_id: q.id, number: fresh.number, deal_id: deal?.id || null, total: fresh.total });
  if (lead) {
    try {
      const { refreshLead } = await import("../ai/smart.js");
      refreshLead({ db, org: { id: orgId }, user: null }, lead.id);
    } catch { /* non bloquant */ }
  }
  logAudit(db, { organizationId: orgId, userId: null, action: "QUOTE_ACCEPTED", resourceType: "quote", resourceId: q.id, metadata: { number: fresh.number, deal_id: deal?.id || null, by: "customer" } });
  for (const m of notifiableMembers(db, orgId)) {
    notifyUser(db, { orgId, userId: m.user_id, type: "QUOTE_ACCEPTED", title: `Devis ${fresh.number} accepté 🎉`, message: `Total : ${fresh.total} ${fresh.currency || currency}`, link: `/dashboard/quotes/${q.id}`, leadId: lead?.id || null });
  }
  return ctx.sendJSON(200, { message: "Devis accepté ! Notre équipe vous contacte pour finaliser la commande et le paiement." });
}

/* ---------- Pages authentifiées (/dashboard/quotes) ---------- */
async function handleDashboardPage(ctx) {
  const { path } = ctx;
  if (!path.startsWith("/dashboard/quotes")) return false;
  if (!ctx.user || !ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403 — Permission insuffisante</h1>"); return true; }
  const db = ctx.db;
  const orgId = ctx.org.id;
  const { currency } = orgCtx(db, orgId);

  const detail = path.match(/^\/dashboard\/quotes\/([0-9a-f-]+)$/i);
  if (detail) {
    const q = maybeExpire(db, orgId, quoteById(db, orgId, detail[1]));
    if (!q) { ctx.sendHTML(404, "<h1>404 — Devis introuvable</h1>"); return true; }
    return ctx.sendHTML(200, quoteDetailPage({
      user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf,
      quote: { ...q, currency: q.currency || currency },
      items: quoteItems(db, q.id),
      customer: customerOf(db, orgId, q),
      lead: q.lead_id ? db.prepare("SELECT id, name, score, status FROM leads WHERE id = ? AND organization_id = ?").get(q.lead_id, orgId) : null,
      deal: q.deal_id ? db.prepare("SELECT id, name, value, stage FROM deals WHERE id = ? AND organization_id = ?").get(q.deal_id, orgId) : null,
      currency,
    }));
  }

  if (path === "/dashboard/quotes") {
    const quotes = db.prepare(
      `SELECT q.*, c.first_name || ' ' || c.last_name AS customer_name, l.name AS lead_name,
              (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS items_count
       FROM quotes q
       LEFT JOIN customers c ON c.id = q.customer_id
       LEFT JOIN leads l ON l.id = q.lead_id
       WHERE q.organization_id = ? ORDER BY q.created_at DESC LIMIT 100`
    ).all(orgId).map((q) => maybeExpire(db, orgId, q));
    return ctx.sendHTML(200, quotesPage({
      user: ctx.user, org: ctx.org, role: ctx.member.role, path, csrf: ctx.csrf,
      quotes, currency,
      customers: db.prepare("SELECT * FROM customers WHERE organization_id = ? ORDER BY first_name LIMIT 200").all(orgId),
      leads: db.prepare("SELECT * FROM leads WHERE organization_id = ? ORDER BY score DESC LIMIT 200").all(orgId),
      products: db.prepare("SELECT id, name, price, discount_price FROM products WHERE organization_id = ? AND status = 'ACTIVE' LIMIT 300").all(orgId),
    }));
  }
  return false;
}

/* ---------- Dispatch unifié des pages (public + dashboard) ---------- */
export async function handlePage(ctx) {
  if (ctx.path.startsWith("/quote/")) return handlePublicQuotePage(ctx);
  if (ctx.path.startsWith("/dashboard/quotes")) return handleDashboardPage(ctx);
  return false;
}

/* ---------- API publique du devis (décision accept/reject) — chaîne API, sans session ---------- */
export async function handlePublicApi(ctx) {
  const d = ctx.path.match(/^\/quote\/([a-zA-Z0-9_-]+)\/decision$/);
  if (d && ctx.method === "POST") return handleDecision(ctx, d[1]);
  return false;
}

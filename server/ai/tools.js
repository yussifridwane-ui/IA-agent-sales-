// server/ai/tools.js — outils sécurisés de l'agent (tool calling)
// Chaque outil : authentification (ctx), ISOLATION organization_id systématique,
// validation des entrées, audit pour les actions sensibles.
// NE JAMAIS faire confiance aux paramètres venant du modèle ou de l'utilisateur :
// le backend valide et rejoue chaque action.
import { randomUUID } from "node:crypto";
import { logAudit } from "../audit.js";
import { searchChunks } from "./embed.js";
import { emitEvent } from "../automation/events.js";
import { processEvent, cancelFollowUpsForLead, smartAssign } from "../automation/engine.js";
import { resolveOutcome } from "../automation/prediction.js";

const now = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Phase 5 : émet un événement et le traite (automations). Jamais bloquant —
 * le flux commercial principal ne doit jamais échouer à cause du moteur
 * d'automatisation (erreur absorbée + journalisée en audit).
 */
async function emit(ctx, type, { entity_type = null, entity_id = null, lead_id = null, conversation_id = null, payload = null } = {}) {
  try {
    const ev = emitEvent(ctx.db, ctx.org.id, { type, entity_type, entity_id, lead_id, conversation_id, payload });
    await processEvent(ctx.db, ev);
    return ev;
  } catch (e) {
    logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "TOOL_ERROR", resourceType: "event", resourceId: type, metadata: { error: String(e.message || e).slice(0, 200) } });
    return null;
  }
}

/** Phase 5 (spec §21-22) : lead HOT sans assignation → assignation intelligente selon règles. */
function maybeAutoAssign(ctx, leadId) {
  try {
    const lead = ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, ctx.org.id);
    if (!lead || lead.assigned_to) return null;
    const r = smartAssign(ctx.db, ctx.org.id, leadId);
    if (r) logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "ASSIGN_LEAD", resourceType: "lead", resourceId: leadId, metadata: { by: "smart_assignment", strategy: r.strategy, user: r.user_id } });
    return r;
  } catch { return null; }
}

export function stockStatus(p) {
  if (!p) return null;
  if (p.type === "SERVICE") return "IN_STOCK";
  if (p.stock_quantity <= 0) return "OUT_OF_STOCK";
  if (p.low_stock_threshold > 0 && p.stock_quantity <= p.low_stock_threshold) return "LOW_STOCK";
  return "IN_STOCK";
}

/** Recherche catalogue — filtrée par org, sans jamais charger tout le catalogue. */
export function toolSearchProducts(ctx, args = {}) {
  const db = ctx.db, org = ctx.org;
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 3, 1), 10);
  const rows = db.prepare(
    `SELECT p.*, c.name AS category_name FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.organization_id = ? AND p.status = 'ACTIVE'`
  ).all(org.id);
  const q = String(args.query || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const qTokens = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  // Un « mot » purement numérique (ex. « 250 000 » = budget) n'exclut rien
  const wordTokens = qTokens.filter((t) => /[a-z]/.test(t));
  const scored = [];
  for (const p of rows) {
    if (args.category && p.category_name && !p.category_name.toLowerCase().includes(String(args.category).toLowerCase())) continue;
    const effPrice = p.discount_price ?? p.price;
    if (args.max_price != null && effPrice > Number(args.max_price)) continue;
    if (args.min_price != null && p.price < Number(args.min_price)) continue;
    if (args.availability === "in_stock" && p.type === "PRODUCT" && p.stock_quantity <= 0) continue;
    let score = 0;
    if (wordTokens.length) {
      const name = (p.name + " " + (p.sku || "")).toLowerCase();
      const cat = (p.category_name || "").toLowerCase();
      const desc = (p.description || "").toLowerCase();
      for (const w of wordTokens) {
        if (name.includes(w)) score += 3;
        else if (cat.includes(w)) score += 2;
        else if (desc.includes(w)) score += 1;
      }
      if (!score) continue;
    }
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ p, score }) => ({
    id: p.id, name: p.name, sku: p.sku, type: p.type, category_name: p.category_name,
    description: p.description, price: p.price, discount_price: p.discount_price, currency: p.currency || org.currency,
    stock_quantity: p.stock_quantity, low_stock_threshold: p.low_stock_threshold, stock_status: stockStatus(p),
    relevance: score,
  }));
}

export function toolGetProduct(ctx, productId) {
  if (!isUuid(productId)) return null;
  const p = ctx.db.prepare(
    `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ? AND p.organization_id = ?`
  ).get(productId, ctx.org.id);
  return p ? { ...p, currency: p.currency || ctx.org.currency, stock_status: stockStatus(p) } : null;
}

export function toolCheckStock(ctx, productId) {
  const p = toolGetProduct(ctx, productId);
  if (!p) return null;
  return { product_id: p.id, name: p.name, stock_quantity: p.stock_quantity, stock_status: stockStatus(p), type: p.type };
}

/** Recherche knowledge base — TOUJOURS filtrée par organization_id. */
export function toolSearchKnowledge(ctx, query, limit = 3) {
  const results = searchChunks(ctx.db, { organizationId: ctx.org.id, query, limit });
  if (results.length) {
    logAudit(ctx.db, {
      organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "KNOWLEDGE_SEARCH",
      resourceType: "knowledge", metadata: { query: String(query).slice(0, 100), hits: results.length },
    });
  }
  return results.map((r) => ({
    chunk_id: r.chunk.chunk_id,
    document_id: r.chunk.document_id,
    document_name: r.chunk.document_name,
    document_type: r.chunk.document_type,
    content: r.chunk.content,
    relevance_score: r.score,
  }));
}

export function toolGetCustomer(ctx, { email, phone } = {}) {
  if (email) {
    const c = ctx.db.prepare("SELECT * FROM customers WHERE organization_id = ? AND email = ?").get(ctx.org.id, String(email).toLowerCase());
    if (c) return c;
  }
  if (phone) {
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length >= 8) {
      const rows = ctx.db.prepare("SELECT * FROM customers WHERE organization_id = ?").all(ctx.org.id);
      const c = rows.find((x) => x.phone && x.phone.replace(/\D/g, "") === digits);
      if (c) return c;
    }
  }
  return null;
}

export function toolCreateCustomer(ctx, { first_name, last_name, email, phone, city, country } = {}) {
  const first = String(first_name || "").slice(0, 50);
  const last = String(last_name || "").slice(0, 50);
  if (!first) throw new Error("create_customer: first_name requis");
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO customers (id, organization_id, first_name, last_name, email, phone, company_name, country, city, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'AI_AGENT', 'ACTIVE', ?, ?)`
  ).run(id, ctx.org.id, first, last || first, email ? String(email).toLowerCase().slice(0, 254) : null,
    phone ? String(phone).slice(0, 20) : null, country || null, city || null, now(), now());
  logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "CREATE_CUSTOMER", resourceType: "customer", resourceId: id, metadata: { by: "ai_agent" } });
  return ctx.db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
}

export function toolGetLead(ctx, leadId) {
  if (!isUuid(leadId)) return null;
  return ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, ctx.org.id) || null;
}

export function toolFindLeadByCustomer(ctx, customerId) {
  if (!isUuid(customerId)) return null;
  return ctx.db.prepare("SELECT * FROM leads WHERE organization_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 1").get(ctx.org.id, customerId) || null;
}

export async function toolCreateLead(ctx, { customer_id, name, company_name, email, phone, source, budget, score, notes, status, interest } = {}) {
  const nm = String(name || "").slice(0, 120);
  if (!nm) throw new Error("create_lead: name requis");
  const id = randomUUID();
  const st = ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON", "LOST"].includes(status) ? status : "NEW";
  ctx.db.prepare(
    `INSERT INTO leads (id, organization_id, customer_id, name, company_name, email, phone, source, status, interest, budget, currency, score, notes, last_contact_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.org.id, isUuid(customer_id) ? customer_id : null, nm,
    company_name ? String(company_name).slice(0, 80) : null,
    email ? String(email).toLowerCase().slice(0, 254) : null, phone ? String(phone).slice(0, 20) : null,
    source || "WEBSITE", st, interest ? String(interest).slice(0, 300) : null,
    budget && Number(budget) > 0 ? Number(budget) : null, ctx.org.currency,
    Math.max(0, Math.min(100, Number(score) || 0)), notes ? String(notes).slice(0, 500) : null, now(), now(), now());
  logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "CREATE_LEAD", resourceType: "lead", resourceId: id, metadata: { by: "ai_agent" } });
  const created = ctx.db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
  await emit(ctx, "LEAD_CREATED", { entity_type: "lead", entity_id: id, lead_id: id, payload: { name: nm, source, score, status: st } });
  if (st === "HOT") { await emit(ctx, "LEAD_BECAME_HOT", { entity_type: "lead", entity_id: id, lead_id: id, payload: { reason: "créé HOT" } }); maybeAutoAssign(ctx, id); }
  return created;
}

export async function toolUpdateLead(ctx, leadId, updates = {}) {
  const lead = toolGetLead(ctx, leadId);
  if (!lead) return null;
  const set = [];
  const args = [];
  if (updates.budget != null) { set.push("budget = ?"); args.push(Math.max(0, Number(updates.budget))); }
  if (updates.interest != null) { set.push("interest = ?"); args.push(String(updates.interest).slice(0, 300)); }
  if (updates.notes != null) { set.push("notes = ?"); args.push(String(updates.notes).slice(0, 2000)); }
  if (updates.next_followup_at != null) { set.push("next_followup_at = ?"); args.push(updates.next_followup_at); }
  if (updates.status != null && ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON", "LOST"].includes(updates.status)) { set.push("status = ?"); args.push(updates.status); }
  if (updates.assigned_to !== undefined) { set.push("assigned_to = ?"); args.push(isUuid(updates.assigned_to) ? updates.assigned_to : null); }
  if (updates.score != null) { set.push("score = ?"); args.push(Math.max(0, Math.min(100, Math.round(Number(updates.score))))); }
  if (set.length) { set.push("updated_at = ?"); args.push(now(), leadId); ctx.db.prepare(`UPDATE leads SET ${set.join(", ")} WHERE id = ?`).run(...args); }
  if (updates.score != null || updates.status != null) {
    logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "UPDATE_LEAD", resourceType: "lead", resourceId: leadId, metadata: { by: "ai_agent", updates: Object.keys(updates) } });
  }
  // Phase 5 : transitions de statut + changement de score (événements)
  const LEAD_ST = ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
  const newStatus = updates.status != null && LEAD_ST.includes(updates.status) ? updates.status : lead.status;
  if (newStatus !== lead.status) {
    await emit(ctx, "LEAD_UPDATED", { entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { from: lead.status, to: newStatus } });
    if (newStatus === "HOT") { await emit(ctx, "LEAD_BECAME_HOT", { entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { from: lead.status } }); maybeAutoAssign(ctx, leadId); }
    else if (lead.status === "HOT") await emit(ctx, "LEAD_BECAME_COLD", { entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { from: lead.status, to: newStatus } });
    if (newStatus === "WON") resolveOutcome(ctx.db, ctx.org.id, leadId, "WON");
    if (newStatus === "LOST") resolveOutcome(ctx.db, ctx.org.id, leadId, "LOST");
  }
  if (updates.score != null && Math.abs(Math.round(Number(updates.score)) - (lead.score ?? 0)) >= 5) {
    await emit(ctx, "LEAD_SCORE_CHANGED", { entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { from: lead.score ?? 0, to: Math.max(0, Math.min(100, Math.round(Number(updates.score)))) } });
  }
  return toolGetLead(ctx, leadId);
}

export async function toolCreateDeal(ctx, { name, value, customer_id, lead_id, probability, stage, currency } = {}) {
  const nm = String(name || "").slice(0, 120);
  if (!nm || value == null) throw new Error("create_deal: name et value requis");
  const v = Math.max(0, Number(value));
  if (!Number.isFinite(v)) throw new Error("create_deal: value invalide");
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO deals (id, organization_id, customer_id, lead_id, name, value, currency, stage, probability, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.org.id, isUuid(customer_id) ? customer_id : null, isUuid(lead_id) ? lead_id : null,
    nm, v, currency || ctx.org.currency, ["NEW", "QUALIFICATION", "PROPOSAL", "NEGOTIATION"].includes(stage) ? stage : "NEW",
    Math.max(0, Math.min(100, Number(probability) || 50)), now(), now());
  logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "CREATE_DEAL", resourceType: "deal", resourceId: id, metadata: { by: "ai_agent", value: v } });
  const dealRow = ctx.db.prepare("SELECT * FROM deals WHERE id = ?").get(id);
  await emit(ctx, "DEAL_CREATED", { entity_type: "deal", entity_id: id, lead_id: isUuid(lead_id) ? lead_id : null, payload: { name: nm, value: v, stage: dealRow.stage } });
  await emit(ctx, "QUOTE_CREATED", { entity_type: "deal", entity_id: id, lead_id: isUuid(lead_id) ? lead_id : null, payload: { name: nm, value: v } });
  return dealRow;
}

export async function toolUpdateDeal(ctx, dealId, updates = {}) {
  const deal = isUuid(dealId) ? ctx.db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(dealId, ctx.org.id) : null;
  if (!deal) return null;
  const set = [];
  const args = [];
  if (updates.stage && ["NEW", "QUALIFICATION", "PROPOSAL", "NEGOTIATION", "WON", "LOST"].includes(updates.stage)) { set.push("stage = ?"); args.push(updates.stage); }
  if (updates.probability != null) { set.push("probability = ?"); args.push(Math.max(0, Math.min(100, Number(updates.probability)))); }
  if (updates.value != null) { set.push("value = ?"); args.push(Math.max(0, Number(updates.value))); }
  if (set.length) { set.push("updated_at = ?"); args.push(now(), dealId); ctx.db.prepare(`UPDATE deals SET ${set.join(", ")} WHERE id = ?`).run(...args); }
  if (updates.stage) {
    logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "CHANGE_DEAL_STAGE", resourceType: "deal", resourceId: dealId, metadata: { by: "ai_agent", to: updates.stage } });
    if (updates.stage !== deal.stage) {
      await emit(ctx, "DEAL_STAGE_CHANGED", { entity_type: "deal", entity_id: dealId, lead_id: deal.lead_id || null, payload: { from: deal.stage, to: updates.stage, value: deal.value } });
      if (updates.stage === "PROPOSAL") await emit(ctx, "QUOTE_SENT", { entity_type: "deal", entity_id: dealId, lead_id: deal.lead_id || null, payload: { value: deal.value } });
      if (updates.stage === "WON") {
        await emit(ctx, "DEAL_WON", { entity_type: "deal", entity_id: dealId, lead_id: deal.lead_id || null, payload: { value: deal.value } });
        await closeDealSideEffects(ctx, deal, "WON");
      }
      if (updates.stage === "LOST") {
        await emit(ctx, "DEAL_LOST", { entity_type: "deal", entity_id: dealId, lead_id: deal.lead_id || null, payload: { value: deal.value } });
        await closeDealSideEffects(ctx, deal, "LOST");
      }
    }
  }
  return toolGetDeal(ctx, dealId);
}

/** Phase 5 (spec §54) : deal clos → outcome résolu, lead mis à jour, toutes les
 *  séquences + follow-ups du lead arrêtés (aucune relance inutile). */
async function closeDealSideEffects(ctx, deal, outcome) {
  if (!deal.lead_id) return;
  try {
    resolveOutcome(ctx.db, ctx.org.id, deal.lead_id, outcome);
    const lead = ctx.db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(deal.lead_id, ctx.org.id);
    if (lead && lead.status !== outcome) {
      ctx.db.prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?").run(outcome, now(), deal.lead_id);
      await emit(ctx, "LEAD_UPDATED", { entity_type: "lead", entity_id: deal.lead_id, lead_id: deal.lead_id, payload: { from: lead.status, to: outcome } });
    }
    cancelFollowUpsForLead(ctx.db, ctx.org.id, deal.lead_id, outcome === "WON" ? "Deal gagné" : "Lead perdu");
  } catch {}
}

export function toolGetDeal(ctx, dealId) {
  if (!isUuid(dealId)) return null;
  return ctx.db.prepare("SELECT * FROM deals WHERE id = ? AND organization_id = ?").get(dealId, ctx.org.id) || null;
}

export function toolCreateTask(ctx, { title, description, priority, due_date, assigned_to, lead_id, customer_id, deal_id } = {}) {
  const t = String(title || "").slice(0, 200);
  if (!t) throw new Error("create_task: title requis");
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO tasks (id, organization_id, assigned_to, customer_id, lead_id, deal_id, title, description, priority, status, due_date, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'TODO', ?, ?, ?, ?)`
  ).run(id, ctx.org.id, isUuid(assigned_to) ? assigned_to : null, isUuid(customer_id) ? customer_id : null,
    isUuid(lead_id) ? lead_id : null, isUuid(deal_id) ? deal_id : null,
    t, description ? String(description).slice(0, 1000) : null,
    ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(priority) ? priority : "MEDIUM",
    due_date || null, ctx.user?.id || null, now(), now());
  logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "TOOL_CALL", resourceType: "task", resourceId: id, metadata: { tool: "create_task", by: "ai_agent" } });
  return ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function toolAddNote(ctx, { content, customer_id, lead_id, deal_id } = {}) {
  const c = String(content || "").slice(0, 5000);
  if (!c) throw new Error("add_note: content requis");
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO notes (id, organization_id, user_id, customer_id, lead_id, deal_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.org.id, ctx.user?.id || null, isUuid(customer_id) ? customer_id : null, isUuid(lead_id) ? lead_id : null,
    isUuid(deal_id) ? deal_id : null, c, now(), now());
  return ctx.db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
}

export function toolCreateActivity(ctx, { type, description, customer_id, lead_id, deal_id } = {}) {
  const allowed = ["CALL", "EMAIL", "MESSAGE", "MEETING", "NOTE", "STATUS_CHANGE", "FOLLOW_UP", "PURCHASE"];
  const ty = allowed.includes(type) ? type : "NOTE";
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO activities (id, organization_id, customer_id, lead_id, deal_id, user_id, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.org.id, isUuid(customer_id) ? customer_id : null, isUuid(lead_id) ? lead_id : null,
    isUuid(deal_id) ? deal_id : null, ctx.user?.id || null, ty, description ? String(description).slice(0, 500) : null, now());
  if (ty === "PURCHASE") logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "TOOL_CALL", resourceType: "activity", resourceId: id, metadata: { tool: "create_activity", type: "PURCHASE", by: "ai_agent" } });
  return ctx.db.prepare("SELECT * FROM activities WHERE id = ?").get(id);
}

export function toolCalculateProductTotal(ctx, { product_id, quantity, discount }) {
  const p = toolGetProduct(ctx, product_id);
  if (!p) throw new Error("calculate_product_total: produit introuvable");
  const qty = Math.max(1, Math.min(10000, parseInt(quantity, 10) || 1));
  const unit = p.discount_price ?? p.price;
  const d = Math.max(0, Number(discount) || 0);
  return { product_id: p.id, product_name: p.name, quantity: qty, unit_price: unit, discount: d, total: Math.max(qty * unit - d, 0), currency: p.currency };
}

/** Transfert à un humain : ticket (tâche) + résumé + statut HANDOFF. */
export function toolHandoffToHuman(ctx, { conversation, reason, summary }) {
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO tasks (id, organization_id, assigned_to, customer_id, lead_id, title, description, priority, status, created_by, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'HIGH', 'TODO', ?, ?, ?)`
  ).run(id, ctx.org.id, conversation.customer_id, conversation.lead_id,
    `[Handoff IA] ${conversation.lead_id ? "Lead " + conversation.lead_id.slice(0, 8) : "Conversation"} — ${String(reason || "transfert").slice(0, 80)}`,
    String(summary || "").slice(0, 1000), ctx.user?.id || null, now(), now());
  ctx.db.prepare("UPDATE conversations SET status = 'HANDOFF', updated_at = ? WHERE id = ?").run(now(), conversation.id);
  logAudit(ctx.db, { organizationId: ctx.org.id, userId: ctx.user?.id || null, action: "HUMAN_HANDOFF", resourceType: "conversation", resourceId: conversation.id, metadata: { reason: String(reason || "").slice(0, 120), task_id: id } });
  return { task_id: id };
}

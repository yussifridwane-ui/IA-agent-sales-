// server/routes/smart.js — Phase 4 : API du Smart Sales Engine
import { randomUUID } from "node:crypto";
import { logAudit } from "../audit.js";
import { can } from "../rbac.js";
import { analyzeLead, refreshLead, detectBuyingSignals, salesCoachAnalysis, conversationSummaryV2 } from "../ai/smart.js";

const now = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const SMART_FILTERS = {
  hot: (w) => w.push("l.hot = 1"),
  high_intent: (w) => w.push("l.purchase_intent IN ('HIGH','VERY_HIGH')"),
  high_value: (w) => w.push("COALESCE(l.estimated_value, 0) >= 1000000"),
  no_followup: (w, args) => { w.push("l.next_followup_at IS NULL"); },
  no_response: (w, args) => { w.push("COALESCE(l.last_contact_at, l.created_at) < datetime('now','-3 day')"); },
  new: (w, args) => { w.push("l.created_at >= datetime('now','-7 day')"); },
  at_risk: (w) => w.push("l.at_risk = 1"),
  ready_to_buy: (w) => w.push("l.purchase_intent IN ('HIGH','VERY_HIGH') AND l.bant_budget IN ('HIGH','CONFIRMED')"),
};

const SORTS = {
  score: "l.score DESC",
  priority: "CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, l.score DESC",
  deal_value: "COALESCE(l.estimated_value, 0) DESC",
  date: "l.created_at DESC",
};

function leadDeal(ctx, leadId) {
  return ctx.db.prepare("SELECT * FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId, ctx.org.id) || null;
}

function leadTimeline(ctx, lead) {
  const db = ctx.db, orgId = ctx.org.id;
  const items = [];
  const push = (ts, type, label, detail) => { if (ts) items.push({ at: ts, type, label, detail }); };
  push(lead.created_at, "lead", "Lead créé", null);
  for (const h of db.prepare("SELECT * FROM lead_score_history WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id)) {
    push(h.created_at, "score", `Score ${h.previous_score ?? "?"} → ${h.score}`, h.reason);
  }
  for (const o of db.prepare("SELECT * FROM objections WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id)) {
    push(o.created_at, "objection", `Objection ${o.type} (${o.severity})`, o.resolved ? "résolue" : "ouverte");
  }
  for (const s of db.prepare("SELECT * FROM buying_signals WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id)) {
    push(s.created_at, "signal", `Signal d'achat : ${s.type}`, s.text);
  }
  for (const a of db.prepare("SELECT a.*, u.first_name, u.last_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.created_at ASC").all(lead.id)) {
    push(a.created_at, "activity", `Activité : ${a.type}`, a.description);
  }
  for (const n of db.prepare("SELECT * FROM notes WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id)) {
    push(n.created_at, "note", "Note ajoutée", n.content.slice(0, 120));
  }
  for (const t of db.prepare("SELECT * FROM tasks WHERE lead_id = ? ORDER BY created_at ASC").all(lead.id)) {
    push(t.created_at, "task", `Tâche : ${t.title}`, t.status);
  }
  for (const d of db.prepare("SELECT * FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at ASC").all(lead.id, orgId)) {
    push(d.created_at, "deal", `Opportunité : ${d.name}`, `${d.stage} · ${d.value} ${lead.currency || "FCFA"}`);
  }
  return items.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 100);
}

export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  if (!path.startsWith("/api/smart/")) return false;
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(401, { error: "Connexion requise." });

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
  const { org, member } = ctx;

  const read = can(member.role, "crm:read");
  const write = can(member.role, "crm:write");
  if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:read)." });

  /* ---------- Liste enrichie des leads (spec §30-31) ---------- */
  if (method === "GET" && path === "/api/smart/leads") {
    const where = ["l.organization_id = ?"];
    const args = [org.id];
    const q = String(ctx.query.q || "").trim();
    if (q) { where.push("(l.name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ? OR l.phone LIKE ?)"); const like = `%${q}%`; args.push(like, like, like, like); }
    if (ctx.query.status) { where.push("l.status = ?"); args.push(String(ctx.query.status).toUpperCase()); }
    if (ctx.query.filter && SMART_FILTERS[ctx.query.filter]) SMART_FILTERS[ctx.query.filter](where, args);
    const sort = SORTS[ctx.query.sort] || SORTS.date;
    const pageSize = Math.min(Math.max(parseInt(ctx.query.page_size, 10) || 25, 1), 100);
    const page = Math.max(parseInt(ctx.query.page, 10) || 1, 1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(" AND ")}`).get(...args).n;
    const leads = db.prepare(
      `SELECT l.*, c.first_name || ' ' || c.last_name AS customer_name,
        (SELECT COUNT(*) FROM messages m JOIN conversations c2 ON c2.id = m.conversation_id WHERE c2.lead_id = l.id) AS messages_count
       FROM leads l LEFT JOIN customers c ON c.id = l.customer_id
       WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT ? OFFSET ?`
    ).all(...args, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, {
      leads: leads.map((l) => ({ ...l, deal_value: leadDeal(ctx, l.id)?.value ?? null })),
      filters: Object.keys(SMART_FILTERS),
      sorts: Object.keys(SORTS),
      pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) },
    });
  }

  /* ---------- Fiche lead intelligente (spec §9, §22-29, §32, §33, §36, §42) ---------- */
  const detail = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)$/i);
  if (method === "GET" && detail) {
    const lead = isUuid(detail[1]) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(detail[1], org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    // Analyse fraîche (lecture seule — pas de persistance sur GET)
    const conv = db.prepare("SELECT * FROM conversations WHERE lead_id = ? AND organization_id = ? ORDER BY updated_at DESC LIMIT 1").get(lead.id, org.id);
    const messages = conv ? db.prepare("SELECT role, content, metadata, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200").all(conv.id) : [];
    const deal = leadDeal(ctx, lead.id);
    const analysis = analyzeLead({ db, org, lead, messages, product: null, deal, rules: db.prepare("SELECT * FROM sales_rules WHERE organization_id = ?").get(org.id) || {} });
    // Produit identifié (via deal ou intérêt)
    const product = productForLead(db, org.id, lead, deal);
    if (product) { const a2 = analyzeLead({ db, org, lead, messages, product, deal, rules: db.prepare("SELECT * FROM sales_rules WHERE organization_id = ?").get(org.id) || {} }); return leadDetailResponse(ctx, lead, a2, messages, deal, product); }
    return leadDetailResponse(ctx, lead, analysis, messages, deal, null);
  }

  /* ---------- Coach IA : « Analyser ce lead » (spec §36) — persistance ---------- */
  const analyze = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/analyze$/i);
  if (method === "POST" && analyze) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const leadId = analyze[1];
    const lead = isUuid(leadId) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const refreshed = refreshLead(ctx, leadId);
    if (!refreshed) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const openObjections = db.prepare("SELECT * FROM objections WHERE organization_id = ? AND lead_id = ? AND resolved = 0").all(org.id, leadId);
    const deal = leadDeal(ctx, leadId);
    return ctx.sendJSON(200, {
      coach: salesCoachAnalysis({ ...refreshed, dimensions: refreshed.dimensions, purchase_intent: refreshed.purchase_intent, estimated_value: refreshed.estimated_value, conversion_probability: refreshed.conversion_probability, next_best_action_label: refreshed.next_best_action_label, next_best_action_reason: refreshed.next_best_action_reason, deal: refreshed.deal, open_objections: refreshed.open_objections, reasons: refreshed.reasons, negatives: refreshed.negatives }, lead, deal, openObjections),
      lead_score: refreshed.score,
      purchase_intent: refreshed.purchase_intent,
      next_best_action: refreshed.next_best_action,
    });
  }

  /* ---------- NBA : confirmer (créer le deal) / ignorer (spec §23, §26) ---------- */
  const nbaConfirm = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/nba\/confirm$/i);
  if (method === "POST" && nbaConfirm) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const leadId = nbaConfirm[1];
    const lead = isUuid(leadId) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    if (lead.next_best_action !== "CREATE_DEAL") return ctx.sendJSON(400, { error: "Aucune action de création de deal recommandée sur ce lead." });
    const existing = leadDeal(ctx, leadId);
    if (existing) return ctx.sendJSON(200, { deal: existing, message: "Un deal existe déjà pour ce lead." });
    const value = lead.estimated_value;
    if (value == null) return ctx.sendJSON(400, { error: "Aucune valeur estimée disponible — impossible de créer le deal sans inventer de valeur." });
    const dealId = randomUUID();
    db.prepare(
      `INSERT INTO deals (id, organization_id, customer_id, lead_id, name, description, value, currency, stage, probability, assigned_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUALIFICATION', ?, ?, ?, ?)`
    ).run(dealId, org.id, lead.customer_id, leadId, `Commande ${lead.name}`, "Créé depuis l'action recommandée du Smart Sales Engine (confirmation humaine).",
      value, lead.currency || org.currency, Math.min(Math.max(lead.conversion_probability || 50, 40), 90), lead.assigned_to, now(), now());
    db.prepare("UPDATE leads SET next_best_action = 'WAIT', next_best_action_reason = ? WHERE id = ?")
      .run("Deal créé par confirmation du commercial.", leadId);
    db.prepare(`INSERT INTO activities (id, organization_id, lead_id, user_id, type, description, created_at) VALUES (?, ?, ?, ?, 'NOTE', ?, ?)`)
      .run(randomUUID(), org.id, leadId, ctx.user.id, `Deal créé (${value} FCFA) — action recommandée confirmée.`, now());
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_DEAL", resourceType: "deal", resourceId: dealId, metadata: { via: "smart_nba_confirm", value } });
    return ctx.sendJSON(201, { deal: db.prepare("SELECT * FROM deals WHERE id = ?").get(dealId), message: `Opportunité de ${value.toLocaleString("fr-FR")} FCFA créée.` });
  }
  const nbaDismiss = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/nba\/dismiss$/i);
  if (method === "POST" && nbaDismiss) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const leadId = nbaDismiss[1];
    const lead = isUuid(leadId) ? db.prepare("SELECT id FROM leads WHERE id = ? AND organization_id = ?").get(leadId, org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    db.prepare("UPDATE leads SET next_best_action = 'WAIT', next_best_action_reason = ? WHERE id = ?").run("Action recommandée ignorée par le commercial.", leadId);
    return ctx.sendJSON(200, { message: "Action recommandée ignorée." });
  }

  /* ---------- Follow-up (spec §33) ---------- */
  const followUp = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/follow-up$/i);
  if (method === "POST" && followUp) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const leadId = followUp[1];
    const lead = isUuid(leadId) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const message = String(body.message || lead.follow_up_message || `Relance du lead ${lead.name}.`);
    db.prepare(`INSERT INTO activities (id, organization_id, lead_id, user_id, type, description, created_at) VALUES (?, ?, ?, ?, 'FOLLOW_UP', ?, ?)`)
      .run(randomUUID(), org.id, leadId, ctx.user.id, message.slice(0, 500), now());
    db.prepare("UPDATE leads SET at_risk = 0, next_followup_at = NULL, follow_up_message = NULL, last_contact_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), leadId);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "TOOL_CALL", resourceType: "lead", resourceId: leadId, metadata: { tool: "follow_up" } });
    return ctx.sendJSON(200, { message: "Relance enregistrée." });
  }

  /* ---------- Objections : résoudre ---------- */
  const objResolve = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/objections\/([0-9a-f-]+)\/resolve$/i);
  if (method === "POST" && objResolve) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const obj = isUuid(objResolve[2]) ? db.prepare("SELECT * FROM objections WHERE id = ? AND organization_id = ?").get(objResolve[2], org.id) : null;
    if (!obj || obj.lead_id !== objResolve[1]) return ctx.sendJSON(404, { error: "Objection introuvable." });
    db.prepare("UPDATE objections SET resolved = 1 WHERE id = ?").run(obj.id);
    return ctx.sendJSON(200, { message: `Objection ${obj.type} marquée comme résolue.` });
  }

  /* ---------- Duplication (spec §34) : détecter, fusionner explicitement ---------- */
  const dups = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/duplicates$/i);
  if (method === "GET" && dups) {
    const lead = isUuid(dups[1]) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(dups[1], org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const cands = db.prepare("SELECT * FROM leads WHERE organization_id = ? AND id != ?").all(org.id, lead.id).filter((c) => {
      if (lead.email && c.email && c.email === lead.email) return true;
      const dn = (p) => String(p || "").replace(/\D/g, "");
      if (lead.phone && c.phone && dn(lead.phone) && dn(c.phone) && dn(lead.phone).slice(-8) === dn(c.phone).slice(-8)) return true;
      if (lead.company_name && c.company_name && c.company_name.toLowerCase() === lead.company_name.toLowerCase() &&
          lead.name && c.name && lead.name.toLowerCase().split(" ")[0] === c.name.toLowerCase().split(" ")[0]) return true;
      return false;
    });
    return ctx.sendJSON(200, { duplicates: cands.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, company_name: c.company_name, score: c.score, reason: dupReason(lead, c) })) });
  }
  const merge = path.match(/^\/api\/smart\/leads\/([0-9a-f-]+)\/merge$/i);
  if (method === "POST" && merge) {
    if (!write) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
    const sourceId = merge[1]; // lead conservé (le plus ancien)
    const targetId = String(body.target_id || "");
    if (!isUuid(targetId)) return ctx.sendJSON(400, { error: "target_id invalide." });
    const source = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(sourceId, org.id);
    const target = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(targetId, org.id);
    if (!source || !target) return ctx.sendJSON(404, { error: "Lead(s) introuvable(s)." });
    // Règles sûres : fusion uniquement si mêmes coordonnées (email ou téléphone)
    const dn = (p) => String(p || "").replace(/\D/g, "");
    const sameContact = (source.email && target.email && source.email === target.email) ||
      (source.phone && target.phone && dn(source.phone).slice(-8) === dn(target.phone).slice(-8));
    if (!sameContact) return ctx.sendJSON(409, { error: "Fusion refusée : les coordonnées (e-mail/téléphone) ne correspondent pas. Fusionnez manuellement après vérification." });
    // Transférer les liens du lead fusionné vers le lead conservé
    const reassign = (table, col) => db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(sourceId, targetId);
    reassign("deals", "lead_id");
    reassign("conversations", "lead_id");
    reassign("notes", "lead_id");
    reassign("activities", "lead_id");
    reassign("tasks", "lead_id");
    reassign("objections", "lead_id");
    reassign("buying_signals", "lead_id");
    reassign("lead_score_history", "lead_id");
    // Compléter les infos manquantes du lead conservé
    db.prepare("UPDATE leads SET budget = COALESCE(budget, ?), interest = COALESCE(interest, ?), score = MAX(score, ?), updated_at = ? WHERE id = ?")
      .run(target.budget, target.interest, target.score, now(), sourceId);
    db.prepare("DELETE FROM leads WHERE id = ?").run(targetId);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_LEAD", resourceType: "lead", resourceId: sourceId, metadata: { merge_from: targetId } });
    return ctx.sendJSON(200, { message: `Lead « ${target.name} » fusionné dans « ${source.name} ».` });
  }

  /* ---------- Customer 360 (spec §35) ---------- */
  const c360 = path.match(/^\/api\/smart\/customers\/([0-9a-f-]+)\/360$/i);
  if (method === "GET" && c360) {
    const customer = isUuid(c360[1]) ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(c360[1], org.id) : null;
    if (!customer) return ctx.sendJSON(404, { error: "Client introuvable." });
    const leads = db.prepare("SELECT l.*, (SELECT COUNT(*) FROM messages m JOIN conversations c2 ON c2.id = m.conversation_id WHERE c2.lead_id = l.id) AS messages_count FROM leads l WHERE l.organization_id = ? AND (l.customer_id = ? OR (l.email IS NOT NULL AND l.email = ?)) ORDER BY l.created_at DESC").all(org.id, customer.id, customer.email || "");
    const deals = db.prepare(
      `SELECT d.* FROM deals d WHERE d.organization_id = ? AND (d.customer_id = ? OR d.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY d.created_at DESC`
    ).all(org.id, customer.id, customer.id);
    const conversations = db.prepare("SELECT c.* FROM conversations c WHERE c.organization_id = ? AND c.customer_id = ? ORDER BY c.updated_at DESC").all(org.id, customer.id);
    const activities = db.prepare("SELECT a.*, u.first_name, u.last_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND (a.customer_id = ? OR a.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY a.created_at DESC LIMIT 100").all(org.id, customer.id, customer.id);
    const notes = db.prepare("SELECT n.*, u.first_name, u.last_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND (n.customer_id = ? OR n.lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY n.created_at DESC LIMIT 100").all(org.id, customer.id, customer.id);
    const tasks = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND (customer_id = ? OR lead_id IN (SELECT id FROM leads WHERE customer_id = ?)) ORDER BY created_at DESC LIMIT 50").all(org.id, customer.id, customer.id);
    const bestScore = leads.reduce((mx, l) => Math.max(mx, l.score || 0), 0);
    return ctx.sendJSON(200, {
      profile: customer,
      leads, deals, conversations, activities, notes, tasks,
      score: bestScore,
      pipeline_value: deals.filter((d) => !["WON", "LOST"].includes(d.stage)).reduce((s, d) => s + (d.value || 0), 0),
      won_value: deals.filter((d) => d.stage === "WON").reduce((s, d) => s + (d.value || 0), 0),
    });
  }

  /* ---------- Funnel + conversion (spec §39-40) : données réelles ---------- */
  if (method === "GET" && path === "/api/smart/analytics/funnel") {
    const STAGES = ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON"];
    const rows = db.prepare(
      `SELECT l.status, COUNT(*) AS count, COALESCE(SUM(COALESCE(l.estimated_value, 0)), 0) AS value,
        COALESCE(AVG(julianday(l.updated_at) - julianday(l.created_at)), 0) AS avg_days
       FROM leads l WHERE l.organization_id = ? GROUP BY l.status`
    ).all(org.id);
    const byStage = Object.fromEntries(rows.map((r) => [r.status, r]));
    const funnel = STAGES.map((stage, i) => {
      const cur = byStage[stage] || { count: 0, value: 0, avg_days: 0 };
      const nextStage = STAGES[i + 1];
      const next = byStage[nextStage] || { count: 0 };
      return {
        stage,
        count: cur.count,
        value: cur.value,
        avg_days: Math.round(cur.avg_days * 10) / 10,
        conversion_to_next: nextStage && (cur.count > 0 || next.count > 0) ? (next.count > 0 ? Math.min(Math.round((next.count / Math.max(cur.count, next.count)) * 1000) / 10, 100) : 0) : null,
      };
    });
    const conv = (from, to) => {
      const f = byStage[from]?.count || 0, t = byStage[to]?.count || 0;
      return f + t > 0 ? Math.min(Math.round((t / Math.max(f, t)) * 1000) / 10, 100) : 0;
    };
    return ctx.sendJSON(200, {
      funnel,
      conversions: {
        "lead_to_qualified": conv("NEW", "QUALIFIED"),
        "qualified_to_hot": conv("QUALIFIED", "HOT"),
        "hot_to_proposal": conv("HOT", "PROPOSAL"),
        "proposal_to_won": conv("PROPOSAL", "WON"),
      },
      note: "Conversions calculées sur la distribution actuelle des statuts (données réelles).",
    });
  }

  /* ---------- Recommandations IA (spec §41) ---------- */
  if (method === "GET" && path === "/api/smart/recommendations") {
    const recs = [];
    const hotNoFollowup = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND hot = 1 AND (next_followup_at IS NULL OR next_followup_at < datetime('now'))").get(org.id).n;
    if (hotNoFollowup > 0) recs.push({ type: "followup", text: `${hotNoFollowup} lead(s) chaud(s) n'ont pas de suivi planifié.`, action: "Relancer", link: "/dashboard/leads?filter=hot" });
    const atRisk = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND at_risk = 1").get(org.id).n;
    if (atRisk > 0) recs.push({ type: "risk", text: `${atRisk} lead(s) risquent de se perdre (sans réponse récente).`, action: "Voir", link: "/dashboard/leads?filter=at_risk" });
    const riskyDeals = db.prepare(
      `SELECT d.* FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.organization_id = ? AND d.stage NOT IN ('WON','LOST') AND (
        COALESCE(l.last_contact_at, d.updated_at) < datetime('now','-5 day') OR d.probability <= 30)`
    ).all(org.id);
    if (riskyDeals.length > 0) recs.push({ type: "deal_risk", text: `${riskyDeals.length} opportunité(s) importante(s) sont à risque.`, action: "Voir", link: "/dashboard/deals" });
    const highIntent = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND purchase_intent IN ('HIGH','VERY_HIGH')").get(org.id).n;
    if (highIntent > 0) recs.push({ type: "intent", text: `${highIntent} lead(s) ont une forte intention d'achat.`, action: "Voir", link: "/dashboard/leads?filter=high_intent" });
    const objTotal = db.prepare("SELECT COUNT(*) AS n FROM objections WHERE organization_id = ?").get(org.id).n;
    const objPrice = db.prepare("SELECT COUNT(*) AS n FROM objections WHERE organization_id = ? AND type = 'PRICE'").get(org.id).n;
    if (objTotal >= 3 && objPrice > 0) recs.push({ type: "objection", text: `Les objections prix représentent ${Math.round((objPrice / objTotal) * 100)} % des objections.`, action: "Voir les leads", link: "/dashboard/leads" });
    const newLeads = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND created_at >= datetime('now','-7 day')").get(org.id).n;
    if (newLeads > 0) recs.push({ type: "new", text: `${newLeads} nouveau(x) lead(s) sur 7 jours.`, action: "Voir", link: "/dashboard/leads?filter=new" });
    const readyToBuy = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND purchase_intent IN ('HIGH','VERY_HIGH') AND bant_budget IN ('HIGH','CONFIRMED')").get(org.id).n;
    if (readyToBuy > 0) recs.push({ type: "ready", text: `${readyToBuy} lead(s) prêts à acheter (intention forte + budget compatible).`, action: "Voir", link: "/dashboard/leads?filter=ready_to_buy" });
    return ctx.sendJSON(200, { recommendations: recs });
  }

  /* ---------- Deals enrichis : risque + santé (spec §37-38) ---------- */
  if (method === "GET" && path === "/api/smart/deals") {
    const deals = db.prepare(
      `SELECT d.*, l.name AS lead_name, l.score AS lead_score, l.at_risk AS lead_at_risk,
        COALESCE(l.last_contact_at, d.updated_at) AS last_activity
       FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
       WHERE d.organization_id = ? ORDER BY d.created_at DESC LIMIT 200`
    ).all(org.id);
    const nowMs = Date.now();
    return ctx.sendJSON(200, {
      deals: deals.map((d) => {
        const days = (nowMs - new Date(d.last_activity).getTime()) / 86400000;
        const openObj = db.prepare("SELECT COUNT(*) AS n FROM objections o WHERE o.lead_id = ? AND o.resolved = 0 AND (o.severity = 'HIGH' OR o.severity = 'CRITICAL')").get(d.lead_id || "").n;
        let risk = "LOW", factors = [];
        if (days >= 7) { factors.push("aucune réponse depuis plusieurs jours"); risk = "MEDIUM"; }
        if (openObj > 0) { factors.push("objection majeure non résolue"); risk = "HIGH"; }
        if (d.probability <= 30) { factors.push("probabilité faible"); if (risk === "LOW") risk = "MEDIUM"; }
        if (days >= 14) risk = "HIGH";
        let health;
        if (d.stage === "WON") health = "Won";
        else if (d.stage === "LOST") health = "Lost";
        else if (days >= 10) health = "Stalled";
        else if (risk !== "LOW") health = "At Risk";
        else health = "Healthy";
        return { ...d, risk, risk_factors: factors, health };
      }),
    });
  }

  return false;
}

/* ---------- Helpers ---------- */
function dupReason(lead, cand) {
  if (lead.email && cand.email && cand.email === lead.email) return "même e-mail";
  const dn = (p) => String(p || "").replace(/\D/g, "");
  if (lead.phone && cand.phone && dn(lead.phone).slice(-8) === dn(cand.phone).slice(-8)) return "même téléphone";
  return "même entreprise + même prénom";
}

function productForLead(db, orgId, lead, deal) {
  if (deal) {
    const line = db.prepare(
      `SELECT p.* FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ? AND p.organization_id = ? ORDER BY dp.total DESC LIMIT 1`
    ).get(deal.id, orgId);
    if (line) return line;
  }
  const interest = String(lead.interest || "").toLowerCase();
  if (interest.length >= 3) {
    const rows = db.prepare("SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE'").all(orgId);
    const match = rows.find((p) => interest.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(interest));
    if (match) return match;
  }
  return null;
}

function leadDetailResponse(ctx, lead, analysis, messages, deal, product) {
  const db = ctx.db, orgId = ctx.org.id;
  const customer = lead.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(lead.customer_id, orgId) : null;
  const scoreHistory = db.prepare("SELECT * FROM lead_score_history WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 50").all(orgId, lead.id);
  const objections = db.prepare("SELECT * FROM objections WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC").all(orgId, lead.id);
  const signals = db.prepare("SELECT * FROM buying_signals WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC").all(orgId, lead.id);
  const tasks = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 50").all(orgId, lead.id);
  const notes = db.prepare("SELECT n.*, u.first_name, u.last_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.organization_id = ? AND n.lead_id = ? ORDER BY n.created_at DESC LIMIT 50").all(orgId, lead.id);
  const activities = db.prepare("SELECT a.*, u.first_name, u.last_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.organization_id = ? AND a.lead_id = ? ORDER BY a.created_at DESC LIMIT 100").all(orgId, lead.id);
  const deals = db.prepare("SELECT * FROM deals WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC").all(orgId, lead.id);
  const timeline = leadTimeline(ctx, lead);
  const summary = conversationSummaryV2({
    analysis: { ...analysis, dimensions: analysis.dimensions }, lead, deal, customer, messages,
    buyingSignals: signals.map((s) => ({ type: s.type })),
  });
  const coach = salesCoachAnalysis(analysis, lead, deal, objections.filter((o) => !o.resolved));
  return ctx.sendJSON(200, {
    lead: { ...lead, deal_value: deal?.value ?? lead.estimated_value },
    analysis,
    product: product ? { id: product.id, name: product.name, price: product.price, discount_price: product.discount_price, stock_quantity: product.stock_quantity, currency: product.currency } : null,
    deal: analysis.deal,
    score_history: scoreHistory,
    objections,
    buying_signals: signals,
    tasks, notes, activities, deals,
    conversation: { messages: messages.slice(-60) },
    timeline,
    summary,
    coach,
    bant: analysis.bant,
  });
}

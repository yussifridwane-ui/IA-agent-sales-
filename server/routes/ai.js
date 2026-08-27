// server/routes/ai.js — Phase 3 : API + pages du moteur IA
import { randomUUID } from "node:crypto";
import { cleanText } from "../security.js";
import { logAudit } from "../audit.js";
import { can } from "../rbac.js";
import { processDocument, searchChunks } from "../ai/embed.js";
import { getAgentSettings, getSalesRules, agentChat, PLAN_AI_QUOTA } from "../ai/engine.js";
import { checkLimit, getPlanDef } from "../billing.js";
import {
  agentPage, agentPlaygroundPage, knowledgePage, conversationsPage, conversationDetailPage,
} from "../views/ai.js";

const now = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Phase 8 — quota IA depuis plan_definitions (configurable), repli PLAN_AI_QUOTA
function aiQuotaFor(db, plan) {
  const lim = getPlanDef(db, plan)?.limits?.ai_messages;
  return (lim != null && lim >= 0) ? lim : (PLAN_AI_QUOTA[plan] ?? 0);
}

const AGENT_LANGS = ["fr", "en"];
const AGENT_TONES = ["professional", "friendly", "direct", "premium", "consultative"];
const AGENT_STYLES = ["court", "equilibre", "detaille"];
const KB_TYPES = ["TEXT", "FAQ", "POLICY", "CONDITIONS", "DELIVERY", "RETURN", "WARRANTY", "COMPANY"];

function needOrg(ctx, perm) {
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  if (!ctx.org || !ctx.member) return ctx.sendJSON(403, { error: "Aucune organisation accessible." });
  if (!can(ctx.member.role, perm)) return ctx.sendJSON(403, { error: `Permission insuffisante (${perm}).` });
  return true;
}

function getConversation(ctx, id) {
  if (!isUuid(id)) return null;
  return ctx.db.prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ?").get(id, ctx.org.id) || null;
}

function createConversation(ctx, { channel = "WEBSITE_TEST" } = {}) {
  const agent = getAgentSettings(ctx.db, ctx.org.id);
  const id = randomUUID();
  ctx.db.prepare(
    `INSERT INTO conversations (id, organization_id, agent_id, channel, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', '{}', ?, ?)`
  ).run(id, ctx.org.id, agent.id, channel, now(), now());
  return ctx.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

async function chatHandler(ctx, { channel = "WEBSITE_TEST" } = {}) {
  if (!needOrg(ctx, "crm:read")) return true;
  const { conversation_id, message } = ctx.body;
  if (typeof message !== "string" || !message.trim()) return ctx.sendJSON(400, { error: "message requis" });
  let conversation = conversation_id ? getConversation(ctx, conversation_id) : null;
  if (conversation_id && !conversation) return ctx.sendJSON(404, { error: "Conversation introuvable." });
  if (!conversation) {
    // Phase 8 — limite du plan (conversations / mois)
    const limConv = checkLimit(ctx.db, ctx.org.id, "conversations");
    if (!limConv.ok) return ctx.sendJSON(403, { error: limConv.error, plan: limConv.plan, limit: limConv.limit, used: limConv.used });
    conversation = createConversation(ctx, { channel });
  }
  const result = await agentChat(ctx, conversation, message);
  return ctx.sendJSON(200, { conversation_id: conversation.id, ...result });
}

/** Métriques IA (spec §44/§45) — partagées par l'API et le dashboard principal. */
export function getAiAnalytics(db, orgId) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const convs = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ?").get(orgId).n;
  const msgs = db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.organization_id = ?").get(orgId).n;
  const handoffs = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ? AND status = 'HANDOFF'").get(orgId).n;
  const aiLeads = db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.organization_id = ? AND EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.organization_id = ? AND c.lead_id = l.id)").get(orgId, orgId).n;
  const aiQualified = db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.organization_id = ? AND l.score >= 61 AND EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.organization_id = ? AND c.lead_id = l.id)").get(orgId, orgId).n;
  const aiHot = db.prepare("SELECT COUNT(*) AS n FROM leads l WHERE l.organization_id = ? AND l.score >= 81 AND EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.organization_id = ? AND c.lead_id = l.id)").get(orgId, orgId).n;
  const aiFailures = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND action = 'AI_ERROR'").get(orgId).n;
  const toolCalls = db.prepare("SELECT COALESCE(SUM(tool_calls),0) AS n FROM ai_usage WHERE organization_id = ?").get(orgId).n;
  const resp = db.prepare("SELECT COALESCE(AVG(response_ms),0) AS n FROM ai_usage WHERE organization_id = ?").get(orgId).n;
  const resolved = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ? AND status = 'RESOLVED'").get(orgId).n;
  const usageMonth = db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(orgId, monthStart.toISOString()).n;
  return {
    total_conversations: convs,
    average_messages: convs ? Math.round((msgs / convs) * 10) / 10 : 0,
    ai_leads: aiLeads, qualified_leads: aiQualified, hot_leads: aiHot,
    human_handoffs: handoffs,
    resolution_rate: convs ? Math.round((resolved / convs) * 1000) / 10 : null,
    tool_calls: toolCalls,
    ai_failures: aiFailures,
    average_response_ms: Math.round(resp),
    usage_month: usageMonth,
  };
}

export async function handleApi(ctx) {
  const { path, method, body, db, org } = ctx;
  if (!path.startsWith("/api/ai") && !path.startsWith("/api/knowledge") && !path.startsWith("/api/agent") && path !== "/api/chat") return false;

  /* ---------- CHAT / PLAYGROUND ---------- */
  if (method === "POST" && (path === "/api/chat" || path === "/api/ai/chat" || path === "/api/ai/message" || path === "/api/ai/playground")) {
    return await chatHandler(ctx, { channel: path === "/api/ai/playground" ? "WEBSITE_TEST" : "WEBSITE" });
  }

  /* ---------- CONVERSATIONS ---------- */
  if (method === "GET" && path === "/api/ai/conversations") {
    if (!needOrg(ctx, "crm:read")) return true;
    const page = Math.max(parseInt(ctx.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(ctx.query.page_size, 10) || 20, 1), 100);
    const total = db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ?").get(org.id).n;
    const rows = db.prepare(
      `SELECT c.*, l.name AS lead_name, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.organization_id = ? ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`
    ).all(org.id, pageSize, (page - 1) * pageSize);
    return ctx.sendJSON(200, { conversations: rows, pagination: { page, page_size: pageSize, total, pages: Math.max(Math.ceil(total / pageSize), 1) } });
  }
  const convDetail = path.match(/^\/api\/ai\/conversations\/([0-9a-f-]+)$/i);
  if (method === "GET" && convDetail) {
    if (!needOrg(ctx, "crm:read")) return true;
    const c = getConversation(ctx, convDetail[1]);
    if (!c) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    const messages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200").all(c.id);
    return ctx.sendJSON(200, {
      conversation: { ...c, metadata: safeParse(c.metadata) },
      messages: messages.map((m) => ({ ...m, metadata: safeParse(m.metadata) })),
    });
  }
  const convSummary = path.match(/^\/api\/ai\/conversations\/([0-9a-f-]+)\/summary$/i);
  if (method === "POST" && convSummary) {
    if (!needOrg(ctx, "crm:read")) return true;
    const c = getConversation(ctx, convSummary[1]);
    if (!c) return ctx.sendJSON(404, { error: "Conversation introuvable." });
    const { getProvider } = await import("../ai/provider.js");
    const provider = getProvider();
    const session = safeParse(c.metadata);
    const messages = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('USER','ASSISTANT') ORDER BY created_at DESC LIMIT 24").all(c.id).reverse();
    const lead = c.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(c.lead_id, org.id) : null;
    const summary = await provider.summarizeConversation({ session, intent: session.last_intent || "UNKNOWN", messages, lead });
    session.summary = summary;
    db.prepare("UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(session), now(), c.id);
    return ctx.sendJSON(200, { summary });
  }

  /* ---------- USAGE & ANALYTICS ---------- */
  if (method === "GET" && path === "/api/ai/usage") {
    if (!needOrg(ctx, "dashboard:read")) return true;
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const plan = db.prepare("SELECT plan FROM subscriptions WHERE organization_id = ?").get(org.id)?.plan || "FREE";
    const used = db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, monthStart.toISOString()).n;
    const quota = aiQuotaFor(db, plan);
    const cost = db.prepare("SELECT COALESCE(SUM(estimated_cost),0) AS c FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, monthStart.toISOString()).c;
    const tokens = db.prepare("SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, monthStart.toISOString());
    return ctx.sendJSON(200, { plan, used, quota, cost_usd: cost, tokens: { input: tokens.i, output: tokens.o } });
  }
  if (method === "GET" && path === "/api/ai/analytics") {
    if (!needOrg(ctx, "dashboard:read")) return true;
    return ctx.sendJSON(200, getAiAnalytics(db, org.id));
  }

  /* ---------- AGENT SETTINGS ---------- */
  if (path === "/api/agent/settings" && method === "GET") {
    if (!needOrg(ctx, "crm:read")) return true;
    const agent = getAgentSettings(db, org.id);
    const rules = getSalesRules(db, org.id);
    const versions = db.prepare("SELECT * FROM agent_prompt_versions WHERE organization_id = ? ORDER BY version DESC LIMIT 20").all(org.id);
    const kbCount = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE organization_id = ? AND status = 'READY'").get(org.id).n;
    const productCount = db.prepare("SELECT COUNT(*) AS n FROM products WHERE organization_id = ? AND status = 'ACTIVE'").get(org.id).n;
    const usage = await (async () => {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const plan = db.prepare("SELECT plan FROM subscriptions WHERE organization_id = ?").get(org.id)?.plan || "FREE";
      const used = db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, monthStart.toISOString()).n;
      return { plan, used, quota: aiQuotaFor(db, plan) };
    })();
    return ctx.sendJSON(200, { agent, rules, versions, kb_count: kbCount, product_count: productCount, usage });
  }
  if (path === "/api/agent/settings" && method === "PUT") {
    if (!needOrg(ctx, "org:update")) return true;
    const agent = getAgentSettings(db, org.id);
    const errors = [];
    const next = { ...agent };
    if (body.name !== undefined) { next.name = cleanText(body.name, 60); if (!next.name) errors.push("Nom requis."); }
    if (body.description !== undefined) next.description = cleanText(body.description, 300) || null;
    if (body.language !== undefined) { if (!AGENT_LANGS.includes(body.language)) errors.push("Langue non prise en charge (fr, en)."); else next.language = body.language; }
    if (body.tone !== undefined) { if (!AGENT_TONES.includes(body.tone)) errors.push("Ton non reconnu."); else next.tone = body.tone; }
    if (body.style !== undefined) { if (!AGENT_STYLES.includes(body.style)) errors.push("Style non reconnu."); else next.style = body.style; }
    if (body.personality !== undefined) next.personality = cleanText(body.personality, 300) || null;
    if (body.business_goal !== undefined) next.business_goal = cleanText(body.business_goal, 200) || null;
    if (body.welcome_message !== undefined) next.welcome_message = cleanText(body.welcome_message, 500) || null;
    if (body.fallback_message !== undefined) next.fallback_message = cleanText(body.fallback_message, 500) || null;
    if (body.human_handoff_enabled !== undefined) next.human_handoff_enabled = body.human_handoff_enabled ? 1 : 0;
    // Phase 6 — mode de traitement par défaut (AI / HUMAN / HYBRID)
    if (body.ai_handling_mode !== undefined) {
      const hm = String(body.ai_handling_mode || "").toUpperCase();
      if (!["AI", "HUMAN", "HYBRID"].includes(hm)) errors.push("ai_handling_mode invalide (AI, HUMAN ou HYBRID).");
      else next.ai_handling_mode = hm;
    }
    if (errors.length) return ctx.sendJSON(400, { error: errors.join(" "), errors });
    db.prepare(
      `UPDATE agent_settings SET name = ?, description = ?, language = ?, tone = ?, style = ?, personality = ?, business_goal = ?, welcome_message = ?, fallback_message = ?, human_handoff_enabled = ?, ai_handling_mode = ?, updated_at = ? WHERE id = ?`
    ).run(next.name, next.description, next.language, next.tone, next.style, next.personality, next.business_goal, next.welcome_message, next.fallback_message, next.human_handoff_enabled, next.ai_handling_mode || "AI", now(), agent.id);

    // Versioning des instructions métier (spec §35) — jamais supprimé, nouvelles versions conservées
    if (body.instructions !== undefined) {
      const ins = cleanText(body.instructions, 5000) || "";
      const lastV = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM agent_prompt_versions WHERE organization_id = ?").get(org.id).v;
      db.prepare("UPDATE agent_prompt_versions SET active = 0 WHERE organization_id = ?").run(org.id);
      db.prepare("INSERT INTO agent_prompt_versions (id, organization_id, agent_id, version, instructions, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .run(randomUUID(), org.id, agent.id, lastV + 1, ins, now());
    }
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_ORGANIZATION", resourceType: "agent", resourceId: agent.id, metadata: { fields: Object.keys(body) } });

    // Activation avec vérifications (spec §56)
    if (body.status === "ACTIVE" && agent.status !== "ACTIVE") {
      const kb = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE organization_id = ? AND status = 'READY'").get(org.id).n;
      const prod = db.prepare("SELECT COUNT(*) AS n FROM products WHERE organization_id = ? AND status = 'ACTIVE'").get(org.id).n;
      const rules = getSalesRules(db, org.id);
      const actErrors = [];
      if (!next.name) actErrors.push("nom de l'agent requis");
      if (kb === 0 && prod === 0) actErrors.push("au moins une source de connaissance (Knowledge Base) ou un produit au catalogue");
      if (rules.max_discount_percent < 0 || rules.max_discount_percent > 100) actErrors.push("règles de vente invalides");
      if (actErrors.length) return ctx.sendJSON(400, { error: "Activation impossible : " + actErrors.join(", "), errors: actErrors });
      db.prepare("UPDATE agent_settings SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(now(), agent.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_ORGANIZATION", resourceType: "agent", resourceId: agent.id, metadata: { status: "ACTIVE" } });
    }
    if (body.status === "PAUSED") db.prepare("UPDATE agent_settings SET status = 'PAUSED', updated_at = ? WHERE id = ?").run(now(), agent.id);
    if (body.status === "DRAFT") db.prepare("UPDATE agent_settings SET status = 'DRAFT', updated_at = ? WHERE id = ?").run(now(), agent.id);

    const updated = db.prepare("SELECT * FROM agent_settings WHERE id = ?").get(agent.id);
    return ctx.sendJSON(200, { message: "Agent mis à jour.", agent: updated });
  }

  /* ---------- SALES RULES ---------- */
  if (path === "/api/agent/rules" && method === "GET") {
    if (!needOrg(ctx, "crm:read")) return true;
    return ctx.sendJSON(200, { rules: getSalesRules(db, org.id) });
  }
  if (path === "/api/agent/rules" && method === "PUT") {
    if (!needOrg(ctx, "org:update")) return true;
    const rules = getSalesRules(db, org.id);
    const errors = [];
    const next = { ...rules };
    if (body.max_discount_percent !== undefined) {
      const v = Number(body.max_discount_percent);
      if (!Number.isFinite(v) || v < 0 || v > 100) errors.push("max_discount_percent doit être entre 0 et 100.");
      else next.max_discount_percent = v;
    }
    if (body.negotiation_enabled !== undefined) next.negotiation_enabled = body.negotiation_enabled ? 1 : 0;
    if (body.minimum_order_value !== undefined) {
      const v = body.minimum_order_value === "" ? null : Number(body.minimum_order_value);
      if (v !== null && (!Number.isFinite(v) || v < 0)) errors.push("minimum_order_value invalide.");
      else next.minimum_order_value = v;
    }
    if (body.payment_methods !== undefined) next.payment_methods = cleanText(body.payment_methods, 300) || null;
    if (body.delivery_information !== undefined) next.delivery_information = cleanText(body.delivery_information, 500) || null;
    if (body.return_policy !== undefined) next.return_policy = cleanText(body.return_policy, 500) || null;
    if (errors.length) return ctx.sendJSON(400, { error: errors.join(" "), errors });
    db.prepare(
      `UPDATE sales_rules SET max_discount_percent = ?, negotiation_enabled = ?, minimum_order_value = ?, payment_methods = ?, delivery_information = ?, return_policy = ?, updated_at = ? WHERE id = ?`
    ).run(next.max_discount_percent, next.negotiation_enabled, next.minimum_order_value, next.payment_methods, next.delivery_information, next.return_policy, now(), rules.id);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_ORGANIZATION", resourceType: "sales_rules", resourceId: rules.id });
    return ctx.sendJSON(200, { message: "Règles de vente mises à jour.", rules: next });
  }

  /* ---------- KNOWLEDGE BASE ---------- */
  if (path === "/api/knowledge/documents" && method === "GET") {
    if (!needOrg(ctx, "catalog:read")) return true;
    const rows = db.prepare(
      `SELECT kd.*, (SELECT COUNT(*) FROM knowledge_chunks kc WHERE kc.document_id = kd.id) AS chunks
       FROM knowledge_documents kd WHERE kd.organization_id = ? ORDER BY kd.created_at DESC LIMIT 200`
    ).all(org.id);
    return ctx.sendJSON(200, { documents: rows });
  }
  if (path === "/api/knowledge/documents" && method === "POST") {
    if (!needOrg(ctx, "catalog:write")) return true;
    // Phase 8 — limite du plan (documents KB)
    const limKb = checkLimit(ctx.db, ctx.org.id, "kb_documents");
    if (!limKb.ok) return ctx.sendJSON(403, { error: limKb.error, plan: limKb.plan, limit: limKb.limit, used: limKb.used });
    const name = cleanText(body.name, 120);
    const type = KB_TYPES.includes(String(body.type).toUpperCase()) ? String(body.type).toUpperCase() : "TEXT";
    if (!name) return ctx.sendJSON(400, { error: "Nom du document requis." });
    // FAQ directe : question + réponse (sinon champ content)
    let finalName = name, finalType = type;
    let finalContent = cleanText(body.content, 200000);
    if (body.question && body.answer) {
      finalName = cleanText(body.question, 200) || name;
      finalContent = `Question : ${cleanText(body.question, 300)}\nCatégorie : ${cleanText(body.category, 60) || "Général"}\nRéponse : ${cleanText(body.answer, 3000)}`;
      finalType = "FAQ";
    }
    if (!finalContent || finalContent.length < 20) return ctx.sendJSON(400, { error: "Contenu trop court (20 caractères min.) — un document vide ne peut pas être indexé." });
    const id = randomUUID();
    db.prepare(
      `INSERT INTO knowledge_documents (id, organization_id, name, type, source, status, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'MANUAL', 'PROCESSING', ?, ?, ?)`
    ).run(id, org.id, finalName, finalType, finalContent, now(), now());
    let chunks = 0;
    try {
      const doc = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id);
      chunks = processDocument(db, doc);
    } catch { /* status FAILED déjà posé */ }
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "TOOL_CALL", resourceType: "knowledge", resourceId: id, metadata: { tool: "knowledge_document", chunks } });
    const doc = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id);
    return ctx.sendJSON(201, { id, doc_status: doc.status, chunks, message: doc.status === "READY" ? "Document indexé." : "Échec du traitement du document." });
  }
  const kbItem = path.match(/^\/api\/knowledge\/documents\/([0-9a-f-]+)$/i);
  if (kbItem && method === "DELETE") {
    if (!needOrg(ctx, "catalog:write")) return true;
    const doc = isUuid(kbItem[1]) ? db.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND organization_id = ?").get(kbItem[1], org.id) : null;
    if (!doc) return ctx.sendJSON(404, { error: "Document introuvable." });
    db.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(doc.id);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "TOOL_CALL", resourceType: "knowledge", resourceId: doc.id, metadata: { tool: "knowledge_delete" } });
    return ctx.sendJSON(200, { message: "Document supprimé (chunks inclus)." });
  }
  const kbReindex = path.match(/^\/api\/knowledge\/documents\/([0-9a-f-]+)\/reindex$/i);
  if (kbReindex && method === "POST") {
    if (!needOrg(ctx, "catalog:write")) return true;
    const doc = isUuid(kbReindex[1]) ? db.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND organization_id = ?").get(kbReindex[1], org.id) : null;
    if (!doc) return ctx.sendJSON(404, { error: "Document introuvable." });
    let chunks = 0;
    try { chunks = processDocument(db, doc); } catch { /* FAILED posé */ }
    const updated = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(doc.id);
    return ctx.sendJSON(200, { doc_status: updated.status, chunks, message: updated.status === "READY" ? `Réindexé : ${chunks} chunks.` : "Échec du réindexage." });
  }
  if (path === "/api/knowledge/search" && method === "POST") {
    if (!needOrg(ctx, "catalog:read")) return true;
    const query = cleanText(body.query, 300);
    if (!query) return ctx.sendJSON(400, { error: "query requis" });
    const results = searchChunks(db, { organizationId: org.id, query, limit: 3 });
    // Réponse RAG : meilleur chunk (source de vérité doc < transactionnel — le transactionnel est géré par l'agent)
    const best = results[0] || null;
    return ctx.sendJSON(200, {
      query,
      answer: best ? best.chunk.content.trim() : "Aucun passage pertinent trouvé dans la knowledge base.",
      sources: results.map((r) => ({ document_id: r.chunk.document_id, document_name: r.chunk.document_name, document_type: r.chunk.document_type, chunk_id: r.chunk.chunk_id, relevance_score: r.score })),
    });
  }

  return false;
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

/* ============================ PAGES ============================ */
export async function handlePage(ctx) {
  const { path, method } = ctx;
  if (method !== "GET") return false;
  const p = ctx.path;
  const AI_PAGES = ["/dashboard/agent", "/dashboard/agent/playground", "/dashboard/knowledge", "/dashboard/conversations", "/dashboard/conversations/"];
  if (!AI_PAGES.some((x) => x === p || (x.endsWith("/") && p.startsWith(x)))) return false;
  if (!ctx.user) { ctx.redirect("/login"); return true; }
  if (!ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  if (!ctx.org.onboarding_completed) { ctx.redirect("/onboarding"); return true; }
  if (!can(ctx.member.role, "crm:read")) { ctx.sendHTML(403, "<h1>403</h1>"); return true; }

  const db = ctx.db, org = ctx.org;
  if (path === "/dashboard/agent") {
    const agent = getAgentSettings(db, org.id);
    const rules = getSalesRules(db, org.id);
    const versions = db.prepare("SELECT * FROM agent_prompt_versions WHERE organization_id = ? ORDER BY version DESC LIMIT 10").all(org.id);
    const kbCount = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE organization_id = ? AND status = 'READY'").get(org.id).n;
    const productCount = db.prepare("SELECT COUNT(*) AS n FROM products WHERE organization_id = ? AND status = 'ACTIVE'").get(org.id).n;
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const plan = db.prepare("SELECT plan FROM subscriptions WHERE organization_id = ?").get(org.id)?.plan || "FREE";
    const used = db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, monthStart.toISOString()).n;
    return ctx.sendHTML(200, agentPage(ctx, { agent, rules, versions, kbCount, productCount, plan, used, quota: PLAN_AI_QUOTA[plan] ?? 0 }));
  }
  if (path === "/dashboard/agent/playground") {
    const agent = getAgentSettings(db, org.id);
    return ctx.sendHTML(200, agentPlaygroundPage(ctx, { agent }));
  }
  if (path === "/dashboard/knowledge") {
    const documents = db.prepare(
      `SELECT kd.*, (SELECT COUNT(*) FROM knowledge_chunks kc WHERE kc.document_id = kd.id) AS chunks
       FROM knowledge_documents kd WHERE kd.organization_id = ? ORDER BY kd.created_at DESC LIMIT 200`
    ).all(org.id);
    return ctx.sendHTML(200, knowledgePage(ctx, { documents }));
  }
  if (path === "/dashboard/conversations") {
    const rows = db.prepare(
      `SELECT c.*, l.name AS lead_name, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.organization_id = ? ORDER BY c.updated_at DESC LIMIT 100`
    ).all(org.id);
    return ctx.sendHTML(200, conversationsPage(ctx, { conversations: rows }));
  }
  const detail = path.match(/^\/dashboard\/conversations\/([0-9a-f-]+)$/i);
  if (detail) {
    const c = getConversation(ctx, detail[1]);
    if (!c) { ctx.sendHTML(404, "<h1>404 — Conversation introuvable</h1>"); return true; }
    const messages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200").all(c.id);
    return ctx.sendHTML(200, conversationDetailPage(ctx, { conversation: c, messages }));
  }
  return false;
}

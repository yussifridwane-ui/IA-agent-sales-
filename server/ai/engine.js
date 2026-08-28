// server/ai/engine.js — moteur conversationnel de l'agent IA
// Pipeline (spec §47) : authentifier → organisation → agent → conversation →
// intention → contexte → knowledge base → catalogue → génération → VALIDATION →
// outils autorisés → messages → lead → réponse.
// L'orchestration des outils est DÉTERMINISTE et côté serveur : le modèle ne
// reçoit que des faits, ne choisit pas les actions, ne fournit pas de paramètres
// d'écriture (jamais de confiance aux paramètres du modèle — spec §31).

import { randomUUID } from "node:crypto";
import { getProvider, parseAmounts as parseAmountsIn } from "./provider.js";
import { buildValidator, validateResponse, fallbackFor } from "./validate.js";
import { logAudit } from "../audit.js";
import { getPlanDef } from "../billing.js";
import * as T from "./tools.js";

const now = () => new Date().toISOString();
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Quotas IA mensuels par plan (spec §57) — pas de dépassement silencieux
export const PLAN_AI_QUOTA = { FREE: 50, STARTER: 500, BUSINESS: 5000, PRO: 20000, ENTERPRISE: Infinity };
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_AI_PER_MIN) || 30; // par organisation

const COMMERCIAL_INTENTS = new Set([
  "PRODUCT_SEARCH", "PRODUCT_INFORMATION", "PRICE_INQUIRY", "STOCK_INQUIRY",
  "COMPARISON", "PURCHASE_INTENT", "NEGOTIATION", "PAYMENT", "APPOINTMENT",
]);

// Phase 6 — sujets sensibles (spec « Human Handoff ») : l'IA ne traite pas seule
// les sujets juridiques, la contestation de paiements ou les sujets médicaux.
const SENSITIVE_TOPIC_RE = /(contentieux|juridique|avocat|huissier|tribunal|rgpd|donn[ée]es ?personnelles|escroquerie|arnaque|fraude|sant[ée]|m[ée]dical|hospitalis|remboursement (?:l[ée]gal|obligatoire))/i;

// Score de lead au-delà duquel le contact est considéré VIP (transfert humain).
const VIP_SCORE_THRESHOLD = 90;

const TONE_HINTS = {
  professional: { fr: "Restez professionnel et précis.", en: "Stay professional and precise." },
  friendly: { fr: "Soyez chaleureux et souriant.", en: "Be warm and friendly." },
  direct: { fr: "Soyez direct et sans formules inutiles.", en: "Be direct, no fluff." },
  premium: { fr: "Soyez élégant, posé, orienté conseil de haut niveau.", en: "Be elegant and executive." },
  consultative: { fr: "Posez des questions et guidez vers la meilleure solution.", en: "Ask questions and guide to the best solution." },
};

export function getAgentSettings(db, orgId) {
  let a = db.prepare("SELECT * FROM agent_settings WHERE organization_id = ?").get(orgId);
  if (!a) {
    const id = randomUUID();
    // Bienvenue + fallback anti-hallucination dès la création
    const welcome = "Bonjour ! Je suis votre assistant commercial. Je réponds uniquement à partir de votre catalogue. Comment puis-je vous aider ?";
    const fallback = "Je n'ai pas cette information dans le catalogue. Je peux vous mettre en relation avec un conseiller.";
    db.prepare(
      `INSERT INTO agent_settings (id, organization_id, name, language, tone, style, human_handoff_enabled, status, welcome_message, fallback_message, ai_handling_mode, created_at, updated_at)
       VALUES (?, ?, 'AI Sales Agent', 'fr', 'friendly', 'equilibre', 1, 'DRAFT', ?, ?, 'AI', ?, ?)`
    ).run(id, orgId, welcome, fallback, now(), now());
    a = db.prepare("SELECT * FROM agent_settings WHERE organization_id = ?").get(orgId);
  }
  // Auto-activation soft : si catalogue non vide et agent encore DRAFT → ACTIVE
  // (le commerçant n'a pas à chercher le bouton « Activer » pour le widget)
  if (a && a.status === "DRAFT") {
    const prod = db.prepare("SELECT COUNT(*) AS n FROM products WHERE organization_id = ? AND status = 'ACTIVE'").get(orgId)?.n || 0;
    if (prod > 0) {
      db.prepare("UPDATE agent_settings SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(now(), a.id);
      a = db.prepare("SELECT * FROM agent_settings WHERE organization_id = ?").get(orgId);
    }
  }
  return a;
}

export function getSalesRules(db, orgId) {
  let r = db.prepare("SELECT * FROM sales_rules WHERE organization_id = ?").get(orgId);
  if (!r) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO sales_rules (id, organization_id, max_discount_percent, negotiation_enabled, payment_methods, created_at, updated_at)
       VALUES (?, ?, 0, 0, 'Espèces, Mobile Money', ?, ?)`
    ).run(id, orgId, now(), now());
    r = db.prepare("SELECT * FROM sales_rules WHERE organization_id = ?").get(orgId);
  }
  return r;
}

function parseMeta(conversation) {
  try {
    return JSON.parse(conversation.metadata || "{}") || {};
  } catch {
    return {};
  }
}

function historyMessages(db, conversationId, limit = 12) {
  const rows = db.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE conversation_id = ? AND role IN ('USER','ASSISTANT')
     ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(conversationId, limit);
  return rows.reverse();
}

/**
 * Point d'entrée unique : traite un message utilisateur.
 * ctx : { db, org, user } + conversation (ligne du table conversations)
 */
export async function agentChat(ctx, conversation, messageText, { provider: forcedProvider = null, forceError = false, suggested = false, inbound = null } = {}) {
  const db = ctx.db, org = ctx.org, user = ctx.user;
  const t0 = Date.now();
  // Phase 6 — contexte du message entrant (canal, ID fournisseur, thread e-mail)
  const ch = String(inbound?.channel || conversation.channel || "WEBCHAT").toUpperCase();
  const provider = forcedProvider || getProvider();
  // Journalisation d'erreur IA — l'application ne plante jamais (spec §34)
  const fail = (msg) => {
    logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "AI_ERROR", resourceType: "conversation", resourceId: conversation.id, metadata: { error: String(msg).slice(0, 200) } });
  };
  // Phase 6 — erreurs répétées : chaque échec moteur est compté dans la session ;
  // 2+ erreurs consécutives déclenchent le transfert humain (spec « Human Handoff »).
  const sessionParsed = (() => { try { return JSON.parse(conversation.metadata || "{}") || {}; } catch { return {}; } })();
  const failAndReply = (msg, sess = sessionParsed) => {
    fail(msg);
    sess.ai_errors = (sess.ai_errors || 0) + 1;
    try {
      db.prepare("UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(sess), now(), conversation.id);
    } catch { /* non bloquant */ }
    return unavailableReply();
  };

  /* --- 1. Quota & rate limiting (spec §32, §57) --- */
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const plan = db.prepare("SELECT plan FROM subscriptions WHERE organization_id = ?").get(org.id)?.plan || "FREE";
  const used = db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, monthStart.toISOString()).n;
  // Phase 8 — quota depuis plan_definitions (configurable, -1 = illimité), repli PLAN_AI_QUOTA
  const planLim = getPlanDef(db, plan)?.limits?.ai_messages;
  const quota = (planLim != null && planLim >= 0) ? planLim : (PLAN_AI_QUOTA[plan] ?? 0);
  if (quota !== Infinity && used >= quota) {
    return { reply: `Vous avez utilisé 100 % de votre quota IA (plan ${plan} : ${quota} messages/mois). Passez à un plan supérieur pour continuer.`, quota: { used, quota, plan }, metadata: { blocked: "quota" } };
  }
  const minuteStart = new Date(Date.now() - 60000).toISOString();
  const lastMin = db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND created_at >= ?").get(org.id, minuteStart).n;
  if (lastMin >= RATE_PER_MIN) {
    return { reply: "Trop de messages en cours — merci d'attendre un instant avant de réessayer.", metadata: { blocked: "rate_limit" } };
  }

  /* --- 2. Agent + règles + instructions actives --- */
  const agent = getAgentSettings(db, org.id);
  if (agent.status === "PAUSED") {
    return { reply: "L'assistant est momentanément en pause. Un conseiller vous répondra très bientôt.", metadata: { blocked: "paused" } };
  }
  const rules = getSalesRules(db, org.id);
  const instructions = db.prepare("SELECT instructions FROM agent_prompt_versions WHERE organization_id = ? AND active = 1 ORDER BY version DESC LIMIT 1").get(org.id)?.instructions || null;

  /* --- 3. Contexte de session (mémoire conversationnelle, spec §24) --- */
  const session = parseMeta(conversation);
  const history = historyMessages(db, conversation.id);
  const message = String(messageText || "").slice(0, 2000);

  /* --- 4. Intention + extraction + objection (fournisseur) --- */
  let intentInfo, info, objection;
  try {
    logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "AI_REQUEST", resourceType: "conversation", resourceId: conversation.id, metadata: { message_length: message.length, model: provider.model } });
    const catalogPreview = db.prepare("SELECT p.id, p.name, p.sku, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.organization_id = ? AND p.status = 'ACTIVE' LIMIT 200").all(org.id);
    intentInfo = await provider.classifyIntent(message);
    info = await provider.extractCustomerInformation(message, { catalog: catalogPreview, session });
    objection = await provider.detectObjection(message);
  } catch (e) {
    return failAndReply(e);
  }
  const intent = intentInfo.intent;
  const confidence = intentInfo.confidence;

  // Mémoire conversationnelle (spec §24) : un montant seul après une recherche
  // en cours sans produit sélectionné = budget → reprise de la recherche.
  const continuation = intent === "UNKNOWN" && info.budget != null && session.last_intent === "PRODUCT_SEARCH" && !session.product_id;
  const effIntent = continuation ? "PRODUCT_SEARCH" : intent;

  /* --- 5. Fusion du contexte de session (mémoire) --- */
  for (const k of ["name", "phone", "email", "budget", "quantity", "city", "country", "brand", "color", "need"]) {
    if (info[k] != null) session[k] = info[k];
  }
  if (info.product) { session.product = info.product; session.product_id = info.product_id || null; }
  if (info.urgency) session.urgency = true;
  if (objection) session.objections = [...new Set([...(session.objections || []), objection])];
  session.last_intent = intent;

  /* --- 6. Orchestration des outils (déterministe, tenant-scopée) --- */
  const toolCalls = [];
  const context = { products: [], selected: null, knowledge: [], alternative: [], total: null };
  try {
    const productIntents = new Set(["PRODUCT_SEARCH", "PRODUCT_INFORMATION", "PRICE_INQUIRY", "STOCK_INQUIRY", "COMPARISON", "PURCHASE_INTENT"]);
    if (productIntents.has(effIntent) || effIntent === "NEGOTIATION") {
      const limit = effIntent === "COMPARISON" ? 5 : 3;
      context.products = T.toolSearchProducts(ctx, {
        query: info.product ? "" : (message.length <= 60 ? message : (session.need || session.product || "")),
        category: session.brand ? undefined : undefined,
        max_price: info.budget ?? session.budget ?? null,
        availability: effIntent === "STOCK_INQUIRY" ? undefined : "in_stock",
        limit,
      });
      toolCalls.push("search_products");
      // Produit sélectionné : correspondance explicite ou mémorisé
      let selId = info.product_id || session.product_id || null;
      if (!selId && info.product) {
        const match = context.products.find((p) => p.name.toLowerCase() === info.product.toLowerCase());
        if (match) selId = match.id;
      }
      if (process.env.DEBUG_PURCHASE) console.error("[DEBUG] selId=", selId, "info.product=", info.product, "context.products=", context.products.map(p => p.name + "(stock=" + p.stock_quantity + ")"));
      if (selId) {
        const p = T.toolGetProduct(ctx, selId);
        if (p) { context.selected = p; toolCalls.push("get_product", "check_stock"); }
        if (process.env.DEBUG_PURCHASE) console.error("[DEBUG] selected=", p ? p.name + " stock=" + p.stock_quantity + " type=" + p.type : "null");
      }
      if (effIntent === "PURCHASE_INTENT" && context.selected) {
        try {
          context.total = T.toolCalculateProductTotal(ctx, { product_id: context.selected.id, quantity: info.quantity ?? session.quantity ?? 1, discount: 0 }).total;
          toolCalls.push("calculate_product_total");
        } catch { context.total = null; }
      }
    }
    if (["DELIVERY", "RETURN", "PAYMENT", "SUPPORT", "COMPLAINT", "UNKNOWN"].includes(effIntent)) {
      context.knowledge = T.toolSearchKnowledge(ctx, message, 3);
      toolCalls.push("search_knowledge");
    }
    if (effIntent === "NEGOTIATION") {
      // Alternative moins chère, même domaine, disponible
      const base = context.selected || context.products[0];
      if (base) {
        const cheaper = T.toolSearchProducts(ctx, { max_price: base.price * 0.9, availability: "in_stock", limit: 5 })
          .filter((p) => p.id !== base.id && (base.category_name ? p.category_name === base.category_name : true))
          .sort((a, b) => (a.discount_price ?? a.price) - (b.discount_price ?? b.price));
        context.alternative = cheaper.slice(0, 2);
      }
    }
  } catch (e) {
    logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "TOOL_ERROR", resourceType: "conversation", resourceId: conversation.id, metadata: { error: String(e.message).slice(0, 200) } });
  }

  /* --- 7. Décision de transfert humain (spec §28 + Phase 6 « Human Handoff ») ---
     Déclencheurs : demande de conseiller, plainte, négociation complexe (écart de
     prix), confiance IA insuffisante, sujet sensible, lead VIP, erreurs IA répétées. */
  // Phase 6 — « confiance IA insuffisante » : ne s'applique qu'à une
  // classification INCERTAINE. La continuation mémoire (montant seul après une
  // recherche en cours) est un flux déterministe — pas une devinette.
  const effConfidence = continuation ? "MEDIUM" : confidence;
  let handoff = false;
  let handoffReason = null;
  // Phase 6 — lead lié (session ou conversation) pour le déclencheur VIP
  const vipLeadId = session.lead_id || conversation.lead_id || null;
  const vipLead = vipLeadId ? T.toolGetLead(ctx, vipLeadId) : null;
  if (intent === "HUMAN_REQUEST") { handoff = true; handoffReason = "demande de conseiller"; }
  else if (intent === "COMPLAINT") { handoff = true; handoffReason = "plainte"; }
  else if (effIntent === "NEGOTIATION" && (rules.negotiation_enabled ? Number(rules.max_discount_percent) : 0) === 0 && session.budget != null && Number(rules.minimum_order_value) > 0 && (context.selected?.price || 0) < Number(rules.minimum_order_value)) {
    handoff = true; handoffReason = "négociation sous le minimum";
  }
  else if (effIntent === "NEGOTIATION" && context.selected && (info.budget ?? session.budget) != null && Number(info.budget ?? session.budget) < Number(context.selected.price) * 0.8) {
    handoff = true; handoffReason = "négociation complexe (écart de prix important)";
  }
  else if (effConfidence === "LOW" && COMMERCIAL_INTENTS.has(effIntent)) {
    handoff = true; handoffReason = "confiance IA insuffisante";
  }
  else if (SENSITIVE_TOPIC_RE.test(message)) {
    handoff = true; handoffReason = "sujet sensible (juridique / contestation / médical)";
  }
  else if ((vipLead?.score ?? 0) >= VIP_SCORE_THRESHOLD) {
    handoff = true; handoffReason = `lead VIP (score ${vipLead.score} ≥ ${VIP_SCORE_THRESHOLD})`;
  }
  else if ((session.ai_errors || 0) >= 2) {
    handoff = true; handoffReason = "erreurs IA répétées (2+ échecs consécutifs)";
  }

  /* --- 8. Score lead (spec §23, borné 0-100) --- */
  let scoreInfo = { delta: 0, factors: [] };
  try { scoreInfo = await provider.scoreLead({ intent, info, session, objection }); } catch { /* déterministe de toute façon */ }
  const existingLead = session.lead_id ? T.toolGetLead(ctx, session.lead_id) : null;
  const baseScore = existingLead?.score ?? 20;
  const newScore = Math.max(0, Math.min(100, baseScore + scoreInfo.delta));

  /* --- 9. Actions CRM (spec §21-22, §42) --- */
  const actions = [];
  let customer = null, lead = null, deal = null;
  const hasContact = !!(info.email || info.phone || session.email || session.phone);
  const hasName = !!(info.name || session.name);
  const shouldCreateLead =
    (COMMERCIAL_INTENTS.has(intent) && (hasContact || hasName || info.product || session.product)) ||
    intent === "PURCHASE_INTENT";
  try {
    if (hasContact || hasName) {
      customer = T.toolGetCustomer(ctx, { email: info.email || session.email, phone: info.phone || session.phone });
      if (!customer && hasName) {
        const parts = String(session.name).split(/\s+/);
        customer = T.toolCreateCustomer(ctx, {
          first_name: parts[0], last_name: parts.slice(1).join(" ") || parts[0],
          email: info.email || session.email || null, phone: info.phone || session.phone || null,
          city: session.city || null, country: session.country || null,
        });
        actions.push("client_cree");
      }
      if (customer) session.customer_id = customer.id;
    }
    if (shouldCreateLead) {
      lead = existingLead || (customer ? T.toolFindLeadByCustomer(ctx, customer.id) : null);
      if (lead) {
        const up = { score: newScore, budget: info.budget ?? session.budget ?? lead.budget, interest: session.need || (context.selected ? context.selected.name : undefined) };
        if (intent === "PURCHASE_INTENT") up.status = lead.status === "NEW" || lead.status === "CONTACTED" ? "HOT" : lead.status;
        else if (newScore >= 81 && ["NEW", "CONTACTED"].includes(lead.status)) up.status = "HOT";
        else if (newScore >= 61 && lead.status === "NEW") up.status = "CONTACTED";
        if (info.urgency) up.next_followup_at = now();
        lead = await T.toolUpdateLead(ctx, lead.id, up);
        actions.push("lead_mis_a_jour");
      } else {
        const nm = (hasName && `${session.name}${customer ? "" : ""}`) || (customer ? `${customer.first_name} ${customer.last_name}` : null) || (info.email || "").split("@")[0] || null;
        if (nm) {
          lead = await T.toolCreateLead(ctx, {
            customer_id: customer?.id || null, name: nm, company_name: info.company_name || null,
            email: info.email || session.email || null, phone: info.phone || session.phone || null,
            source: "WEBSITE", budget: info.budget ?? session.budget ?? null, score: newScore,
            status: intent === "PURCHASE_INTENT" ? "HOT" : "NEW",
            interest: session.need || (context.selected ? context.selected.name : null),
            notes: session.need ? `Besoin détecté : ${session.need}` : null,
          });
          actions.push("lead_cree");
        }
      }
      if (lead) {
        session.lead_id = lead.id;
        if (intent === "PURCHASE_INTENT") {
          T.toolCreateActivity(ctx, { type: "PURCHASE", description: `Intention d'achat détectée : ${context.selected?.name || session.product || "produit"}`, lead_id: lead.id, customer_id: customer?.id || null });
          actions.push("activite_achat");
          // Jamais de deal pour un produit hors stock (ni de promesse de commande)
          const available = context.selected && (context.selected.type === "SERVICE" || context.selected.stock_quantity > 0);
          if (process.env.DEBUG_PURCHASE) console.error("[DEBUG] PURCHASE lead=", lead?.name, "selected=", context.selected?.name, "available=", available, "total=", context.total);
          if (available) {
            deal = await T.toolCreateDeal(ctx, {
              name: `Commande ${context.selected.name}`, value: context.total ?? context.selected.discount_price ?? context.selected.price,
              customer_id: customer?.id || null, lead_id: lead.id, probability: 60, stage: "QUALIFICATION",
            });
            // Ligne produit sur le deal (la commande = produit + quantité + prix, jamais de valeur orpheline)
            const qty = Math.max(1, Math.min(10000, Number(info.quantity ?? session.quantity ?? 1) || 1));
            const unit = Number(context.selected.discount_price ?? context.selected.price) || 0;
            db.prepare(
              `INSERT INTO deal_products (id, organization_id, deal_id, product_id, quantity, unit_price, discount, total, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
            ).run(randomUUID(), ctx.org.id, deal.id, context.selected.id, qty, unit, deal.value ?? qty * unit, now(), now());
            session.deal_id = deal.id;
            actions.push("deal_cree");
            // Persistance de la Next Best Action (spec §23) : achat confirmé → préparer la commande
            db.prepare("UPDATE leads SET next_best_action = 'CREATE_DEAL', next_best_action_reason = ? WHERE id = ?")
              .run("Achat confirmé (deal avec lignes produits) — préparer la commande et transmettre au commercial.", lead.id);
            lead.next_best_action = "CREATE_DEAL";
          }
        }
        if (intent === "APPOINTMENT") {
          T.toolCreateTask(ctx, { title: `Rendez-vous demandé par ${lead.name}`, description: `Demmande via chat IA. Tél : ${session.phone || "—"} · Ville : ${session.city || "—"}`, priority: "HIGH", lead_id: lead.id, customer_id: customer?.id || null });
          actions.push("tache_rdv");
        }
      }
    }
    if (handoff) {
      const summary = (await provider.summarizeConversation({ session, intent, messages: history, lead })).prochaine_action || "Transfert conseiller";
      T.toolHandoffToHuman(ctx, { conversation, reason: handoffReason, summary: JSON.stringify({ ...summarizePlain({ session, intent, lead }), motif: handoffReason }) });
      actions.push("handoff_humain");
      session.handoff = true;
    }
  } catch (e) {
    logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "TOOL_ERROR", resourceType: "conversation", resourceId: conversation.id, metadata: { error: String(e.message).slice(0, 200) } });
  }

  /* --- 10. Génération (fournisseur) --- */
  const agentArgs = {
    agent: { ...agent, custom_instructions: instructions }, rules, intent: effIntent, info, session,
    products: context.products, selected: context.selected, knowledge: context.knowledge,
    objection, alternative: context.alternative, total: context.total, handoff, actions, history,
    tone_hint: TONE_HINTS[agent.tone]?.[agent.language === "en" ? "en" : "fr"] || "",
  };
  let gen;
  try {
    if (forceError || process.env.AI_FORCE_ERROR) throw new Error(process.env.AI_FORCE_ERROR ? "fournisseur indisponible (force test)" : "fournisseur IA indisponible (test)");
    gen = await provider.generateResponse(agentArgs);
  } catch (e) {
    return failAndReply(e, session);
  }
  // Le fournisseur OpenAI a basculé sur le repli local : on journalise l'incident
  if (gen?.error) fail(gen.error);
  const responseMs = Date.now() - t0;

  /* --- 11. VALIDATION avant envoi (spec §48) --- */
  // Les montants cités dans les sources KB proviennent des documents de l'organisation
  const kbAmounts = (context.knowledge || []).flatMap((k) => parseAmountsIn(k.content || ""));
  const validator = buildValidator(ctx, { session, products: context.products, selected: context.selected, total: context.total, rules, extraAmounts: kbAmounts });
  const validation = validateResponse(gen.text, { ...validator, rules });
  let reply = gen.text;
  if (!validation.ok) {
    logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "AI_RESPONSE", resourceType: "conversation", resourceId: conversation.id, metadata: { validation_failed: validation.checks.map((c) => c.fail) } });
    reply = fallbackFor(agent);
    // Phase 6 — erreur de validation comptée pour le déclencheur « erreurs IA répétées »
    session.ai_errors = (session.ai_errors || 0) + 1;
  } else {
    session.ai_errors = 0; // série d'erreurs rompue
  }

  /* --- 12. Persistance (messages, conversation, usage, audit) --- */
  const userMsgId = randomUUID();
  const aiMsgId = randomUUID();
  const metadata = {
    intent: effIntent, confidence,
    lead_score: newScore,
    score_factors: scoreInfo.factors,
    tools: toolCalls,
    products: context.products.map((p) => p.name),
    selected: context.selected?.name || null,
    sources: context.knowledge.map((k) => ({ document: k.document_name, document_id: k.document_id, chunk_id: k.chunk_id, relevance_score: k.relevance_score })),
    actions,
    handoff,
    model: gen.model,
    validation: validation.ok ? "ok" : validation.checks.map((c) => c.fail),
  };
  // Metadata du message user (intent + extraction) : alimente le Smart Sales Engine (Phase 4)
  // Phase 6 — colonnes omnicanal sur les messages (canal, direction, thread e-mail, ID fournisseur)
  const userMsgMeta = JSON.stringify({ intent: effIntent, confidence, extracted: info, source: provider.model, channel: ch, subject: inbound?.subject || null });
  // Threading e-mail (spec Phase 6) : thread_id = In-Reply-To || 1er References || Message-ID
  const emailRefs = inbound?.emailReferences ? String(inbound.emailReferences).split(/\s+/).filter(Boolean) : [];
  const emailThreadId = ch === "EMAIL"
    ? (inbound?.inReplyTo || emailRefs[0] || inbound?.externalMessageId || null)
    : null;
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, metadata, channel, direction, external_message_id, thread_id, in_reply_to, email_references, external_contact_id, created_at)
     VALUES (?, ?, 'USER', ?, ?, ?, 'INBOUND', ?, ?, ?, ?, ?, ?)`
  ).run(userMsgId, conversation.id, message, userMsgMeta, ch,
    inbound?.externalMessageId ? String(inbound.externalMessageId).slice(0, 255) : null,
    emailThreadId ? String(emailThreadId).slice(0, 255) : null,
    inbound?.inReplyTo ? String(inbound.inReplyTo).slice(0, 255) : null,
    inbound?.emailReferences ? String(inbound.emailReferences).slice(0, 1000) : null,
    inbound?.externalContactId ? String(inbound.externalContactId).slice(0, 160) : null, now());

  if (suggested) {
    // Phase 6 — mode HYBRID : la réponse n'est PAS envoyée ; elle est proposée
    // à l'humain (suggested_replies, statut PENDING) qui l'approuve/rejette.
    const suggId = randomUUID();
    const confScore = confidence === "HIGH" ? 80 : confidence === "MEDIUM" ? 60 : 40;
    metadata.rationale = [
      `Intention ${effIntent} (confiance ${confidence})`,
      context.selected ? `Produit : ${context.selected.name}` : null,
      objection ? `Objection : ${objection}` : null,
      lead ? `Lead : ${lead.name} (score ${newScore})` : null,
    ].filter(Boolean).join(" · ");
    db.prepare(
      `INSERT INTO suggested_replies (id, organization_id, conversation_id, message_id, content, rationale, confidence, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'ai', ?)`
    ).run(suggId, org.id, conversation.id, userMsgId, String(reply).slice(0, 4000), metadata.rationale, confScore, now());
    metadata.suggested_id = suggId;
  } else {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, metadata, channel, direction, delivery_status, created_at)
       VALUES (?, ?, 'ASSISTANT', ?, ?, ?, 'OUTBOUND', 'SENT', ?)`
    ).run(aiMsgId, conversation.id, reply, JSON.stringify(metadata), ch, now());
  }
  // Résumé de conversation pour l'historique long (spec §24)
  const msgCount = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conversation.id).n;
  if (msgCount > 20) {
    try {
      const s = await provider.summarizeConversation({ session, intent, messages: history, lead });
      session.summary = s;
    } catch { /* non bloquant */ }
  }
  db.prepare("UPDATE conversations SET customer_id = COALESCE(?, customer_id), lead_id = COALESCE(?, lead_id), status = ?, metadata = ?, updated_at = ? WHERE id = ?")
    .run(session.customer_id || null, session.lead_id || null, handoff ? "HANDOFF" : conversation.status, JSON.stringify(session), now(), conversation.id);

  // --- Phase 4 : Smart Sales Engine (refresh auto du lead lié, non bloquant) ---
  const effectiveLeadId = session.lead_id || conversation.lead_id;
  if (effectiveLeadId) {
    try {
      const { refreshLead } = await import("./smart.js");
      refreshLead(ctx, effectiveLeadId);
    } catch (e) {
      logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "TOOL_ERROR", resourceType: "lead", resourceId: effectiveLeadId, metadata: { tool: "smart_engine", error: String(e.message).slice(0, 200) } });
    }
  }
  // --- Phase 5 : evenements commerciaux + opt-out + detection de reponse (non bloquant) ---
  try {
    const { emitEvent, leadRepliedSince } = await import("../automation/events.js");
    const { processEvent, cancelFollowUpsForLead, notifyUser, notifiableMembers } = await import("../automation/engine.js");
    const { isOptOutMessage, setOptOut } = await import("../automation/followup.js");
    const fev = (type, payload, et = "conversation", eid = conversation.id) => {
      try { const ev = emitEvent(db, org.id, { type, entity_type: et, entity_id: eid, lead_id: effectiveLeadId || null, conversation_id: conversation.id, payload }); processEvent(db, ev); } catch {}
    };
    if (history.length === 0) fev("CONVERSATION_STARTED", { channel: conversation.channel });
    if (context.products.length) fev("PRODUCT_VIEWED", { products: context.products.map((p) => p.name) }, "lead", effectiveLeadId || conversation.id);
    if (effIntent === "PRODUCT_SEARCH" || effIntent === "PRODUCT_INFORMATION") fev("PRODUCT_INQUIRY", { product: context.selected?.name || null }, "lead", effectiveLeadId || conversation.id);
    if (effIntent === "PRICE_INQUIRY") fev("PRICE_REQUESTED", { product: context.selected?.name || null }, "lead", effectiveLeadId || conversation.id);
    if (intent === "PURCHASE_INTENT") fev("PURCHASE_INTENT_DETECTED", { product: context.selected?.name || null, deal_id: deal?.id || null }, "lead", effectiveLeadId || conversation.id);
    if (handoff) {
      fev("HUMAN_HANDOFF", { reason: handoffReason || null });
      // Notification commerciale (spec 23) : le relais humain est signalé à l'équipe
      for (const m of notifiableMembers(db, org.id)) notifyUser(db, { orgId: org.id, userId: m.user_id, type: "HUMAN_HANDOFF", title: `Relais humain demandé${lead ? " : " + lead.name : ""}`, message: String(handoffReason || ""), link: effectiveLeadId ? `/dashboard/leads/${effectiveLeadId}` : "/dashboard/conversations", leadId: effectiveLeadId || null });
    }
    if (effectiveLeadId) {
      // Opt-out (spec 12, 52) : message de desabonnement → preferences + arret immediat
      if (isOptOutMessage(message)) {
        const leadRow = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(effectiveLeadId, org.id);
        if (leadRow) {
          setOptOut(db, org.id, leadRow);
          fev("OPT_OUT", { message: message.slice(0, 200) }, "lead", effectiveLeadId);
          cancelFollowUpsForLead(db, org.id, effectiveLeadId, "Opt-out du prospect");
        }
      } else if (leadRepliedSince(db, org.id, effectiveLeadId, new Date(Date.now() - 120e3).toISOString())) {
        // Detection de reponse (spec 20) : annuler les follow-ups en attente, marquer les envoyes
        const pend = db.prepare("SELECT id FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SCHEDULED','PENDING_APPROVAL')").all(org.id, effectiveLeadId);
        const sent = db.prepare("SELECT id FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status = 'SENT' AND response_at IS NULL").all(org.id, effectiveLeadId);
        if (pend.length || sent.length) {
          for (const s of sent) db.prepare("UPDATE followup_history SET response_at = ? WHERE id = ?").run(now(), s.id);
          cancelFollowUpsForLead(db, org.id, effectiveLeadId, "reponse du prospect");
          fev("RESPONSE_RECEIVED", { pending_cancelled: pend.length }, "lead", effectiveLeadId);
        }
      }
      // Notification : intention d'achat + deal cree (spec 23)
      if (intent === "PURCHASE_INTENT" && deal) {
        const targets = lead?.assigned_to ? [lead.assigned_to] : notifiableMembers(db, org.id).map((m) => m.user_id);
        for (const uid of targets) notifyUser(db, { orgId: org.id, userId: uid, type: "PURCHASE_INTENT", title: `Intention d'achat : ${lead?.name || "lead"}`, message: `Deal cree : ${deal.name} (${deal.value} ${lead?.currency || org.currency}).`, link: `/dashboard/leads/${effectiveLeadId}`, leadId: effectiveLeadId });
      }
    }
  } catch { /* non bloquant */ }

  db.prepare(
    `INSERT INTO ai_usage (id, organization_id, user_id, conversation_id, model, input_tokens, output_tokens, estimated_cost, tool_calls, response_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), org.id, user?.id || null, conversation.id, gen.model,
    gen.input_tokens || 0, gen.output_tokens || 0,
    estimateCost(gen.model, gen.input_tokens || 0, gen.output_tokens || 0), toolCalls.length, responseMs, now());
  logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "AI_RESPONSE", resourceType: "conversation", resourceId: conversation.id, metadata: { intent, confidence, tools: toolCalls, ms: responseMs } });

  return {
    reply: suggested ? null : reply,
    // Phase 6 — mode HYBRID : la réponse est une suggestion à approuver (pas un envoi)
    suggested: suggested ? {
      id: metadata.suggested_id,
      content: reply,
      rationale: metadata.rationale || null,
      confidence: confidence === "HIGH" ? 80 : confidence === "MEDIUM" ? 60 : 40,
      status: "PENDING",
    } : null,
    metadata: {
      intent: effIntent, confidence,
      lead_score: newScore,
      products: context.products.map((p) => p.name),
      selected: context.selected?.name || null,
      tool_calls: toolCalls,
      sources: metadata.sources,
      actions,
      handoff,
      customer: customer ? `${customer.first_name} ${customer.last_name}` : null,
      lead: lead ? lead.name : null,
      deal: deal ? deal.name : null,
      validation: metadata.validation,
    },
  };
}

function summarizePlain({ session, intent, lead }) {
  return {
    besoin: session.need || session.product || "Non précisé",
    budget: session.budget ?? null,
    produit: session.product || null,
    objections: session.objections || [],
    urgence: session.urgency || false,
    score: lead?.score ?? null,
  };
}

function unavailableReply() {
  return {
    reply: "Notre assistant est temporairement indisponible. Veuillez réessayer ou contacter un conseiller.",
    metadata: { error: "ai_unavailable" },
  };
}

// Coût estimé (USD) — modèle local = 0
const MODEL_PRICING = {
  "gpt-4o-mini": [0.15, 0.6], "gpt-4o": [2.5, 10], "gpt-4.1-mini": [0.4, 1.6],
};
function estimateCost(model, inTok, outTok) {
  const p = MODEL_PRICING[String(model || "").toLowerCase()];
  if (!p) return 0;
  return Math.round(((inTok / 1e6) * p[0] + (outTok / 1e6) * p[1]) * 1e6) / 1e6;
}

// server/ai/smart.js — Smart Sales Engine (Phase 4)
// Conversation → Intent → Extraction → Qualification (BANT) → Objections →
// Engagement → Lead Scoring multi-dimensionnel → Purchase Intent →
// Conversion Probability (heuristique) → Next Best Action → CRM Update.
//
// Principes :
// - Score 0-100, NÉCCESSAIREMENT borné, EXPLICABLE (raisons + points négatifs).
// - Jamais de données inventées : estimation de valeur uniquement si basée sur
//   un deal ou le catalogue ; probabilité = ESTIMATION heuristique (non validée).
// - Actions automatiques non sensibles : score, activité, signaux, objection,
//   tâche de suivi. Création de deal → recommandée + confirmation humaine.

import { randomUUID } from "node:crypto";
import { logAudit } from "../audit.js";
import { emitEvent } from "../automation/events.js";
import { processEvent, notifyUser, notifiableMembers } from "../automation/engine.js";
import { logPrediction } from "../automation/prediction.js";

const now = () => new Date().toISOString();
const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(v)));
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/* ---------- Scores d'intention configurables (spec §3) ---------- */
export const INTENT_SCORES_DEFAULT = {
  GREETING: 10,            // simple curiosité
  PRODUCT_SEARCH: 25,      // question produit
  PRODUCT_INFORMATION: 25, // question produit
  PRICE_INQUIRY: 35,       // question prix
  STOCK_INQUIRY: 45,       // question stock
  COMPARISON: 50,          // comparaison
  QUOTE: 65,               // demande de devis
  PAYMENT: 75,             // question paiement
  PAYMENT_METHODS: 95,     // "comment payer ?"
  DELIVERY: 80,            // demande de livraison
  PURCHASE_INTENT: 90,     // "je veux acheter"
  PURCHASE_CONFIRMED: 100, // achat confirmé (deal + lignes produits)
  NEGOTIATION: 55,
  APPOINTMENT: 60,
  SUPPORT: 30,
  RETURN: 40,
  COMPLAINT: 20,
  HUMAN_REQUEST: 40,
  UNKNOWN: 5,
};

/* ---------- Détection de l'urgence (spec §7) ---------- */
const URGENCY_PATTERNS = [
  { re: /aujourd'hui|aujourd hui|cette soir|dès que possible|urgent|au plus vite|immediat/i, score: 100, label: "aujourd'hui", bant: "CONFIRMED" },
  { re: /cette semaine|cette semaine|cette semaine|sous (?:quelques jours|une semaine)/i, score: 80, label: "cette semaine", bant: "HIGH" },
  { re: /ce mois|ce mois-ci|ce mois ci|cette mois|sous (?:un mois|30 jours)/i, score: 50, label: "ce mois-ci", bant: "MEDIUM" },
  { re: /plus tard|la semaine prochaine|le mois prochain|eventuellement|eventuellement/i, score: 25, label: "plus tard", bant: "LOW" },
];

/* ---------- Détection de l'autorité (BANT — A) ---------- */
const AUTHORITY_PATTERNS = [
  { re: /je decide|je suis (?:le |la )?(?:directeur|directrice|proprietaire|patron|pdg|gerant|gerante|chefs?)|mon entreprise|notre societe|notre entreprise/i, score: "HIGH", conf: 85 },
  { re: /je dois (?:demander|valider|discuter|remonter)|mon patron|mon superieur|le directeur|en (?:reunion|interne)/i, score: "LOW", conf: 80 },
];

/* ---------- Objections (spec §16-17) : type, sévérité, confiance ---------- */
const OBJECTION_PATTERNS = [
  { type: "PRICE", re: /\bch[èe]re?s?\b|trop ch[èe]re?|prix (?:élevé|eleve|trop)|pas (?:dans )?mon budget|budget (?:limité|limite|serré)/i, severity: "MEDIUM", conf: 90 },
  { type: "TRUST", re: /pas (?:de )?confiance|ne (?:vous |t')?fais pas confiance|doute|arnaque|peur|risque|scellé|scelle|escroc|fraude/i, severity: "HIGH", conf: 90 },
  { type: "QUALITY", re: /qualité|qualite|pas (?:suffisamment )?(?:fiable|solide|durable)|casse|depannage|garantie (?:non|pas)/i, severity: "MEDIUM", conf: 80 },
  { type: "DELIVERY", re: /livraison (?:lente|trop|longue)|delai (?:long|trop)|livrer (?:trop|loin)|ne (?:vous |t')?livrez pas/i, severity: "MEDIUM", conf: 85 },
  { type: "PAYMENT", re: /mode de paiement|comment (?:je )?payer|paiement (?:pas|en|difficile)|pas (?:de )?(?:carte|mobile money|virement)/i, severity: "MEDIUM", conf: 85 },
  { type: "FEATURES", re: /ne (?:peut pas|fait pas|a pas)|manque|pas (?:de )?fonction|insuffisant|limité|limite|pas (?:assez )?(?:complet|riche)/i, severity: "MEDIUM", conf: 75 },
  { type: "COMPETITOR", re: /concurrent|concurrence|comparaison avec|je compare|regarde (?:aussi|autres?)|autre (?:marque|fournisseur|revendeur)/i, severity: "MEDIUM", conf: 80 },
  { type: "TIMING", re: /pas (?:le )?temps|pas (?:le )?moment|plus tard|plus tard|maintenant (?:ce n|ce n) est pas le moment|charge|chargee/i, severity: "LOW", conf: 80 },
  { type: "NEED", re: /ne (?:sais pas|suis pas sur|suis pas certain|suis pas certaine) (?:de |si |quelle|quelle)|pas (?:sûr|sur) (?:de |si)/i, severity: "LOW", conf: 75 },
];
// Sévérité CRITICAL : signaux d'abandon explicite
const CRITICAL_RE = /je vais (?:annuler|rembourser|choisir (?:un |une )?autre)|j'annule|annulation|je (?:choisis|prends) (?:un |une )?autre|je passe (?:chez|à|à) (?:un |une )?autre/i;

/* ---------- Competitor detection (spec §19) ---------- */
const KNOWN_COMPETITORS = ["samsung", "apple", "iphone", "huawei", "xiaomi", "lenovo", "dell", "hp", "acer", "asus", "sony", "jbl", "lg", "nokia", "tecno", "itel", "transsion", "motorola", "google pixel", "pixel"];

/* ---------- Buying signals (spec §20) ---------- */
const BUYING_SIGNALS = [
  { type: "PURCHASE", re: /je veux (?:acheter|commander|le prendre|la prendre)|je (?:achète|achete|prends|commande)|je le (?:prends|veux)|je la (?:prends|veux)/i, conf: 95 },
  { type: "PAYMENT_METHOD", re: /comment (?:je )?payer|modalités? de paiement|modalites de paiement|mode de paiement|comment (?:se )?payer/i, conf: 95 },
  { type: "DELIVERY_AREA", re: /livrez[- ]vous (?:à|a) |livraison (?:à|a) |expediez[- ]vous (?:à|a) /i, conf: 90 },
  { type: "DELIVERY_COST", re: /combien (?:coûte|coute) (?:la |le )?livraison|frais (?:de )?livraison|livraison (?:est-elle |est )?(?:gratuite|payante)/i, conf: 90 },
  { type: "AVAILABILITY", re: /vous avez (?:encore|en stock) |est[- ]ce (?:produit |appareil )?disponible|disponible (?:actuellement|maintenant)/i, conf: 90 },
  { type: "ORDER_TODAY", re: /je peux (?:commander|commander aujourd'hui|le commander aujourd)|commande (?:aujourd|maintenant)/i, conf: 95 },
  { type: "TAKE_PRODUCT", re: /je (?:le |la )?prends|c'est (?:bon |ok )?(?:je )?le (?:prends|prends)|partant|d'accord (?:je )?(?:le |la )?prends/i, conf: 95 },
];

/* ---------- Urgences / besoins ---------- */
const NEED_USAGE_RE = /pour (?:programmer|coder|developper|travailler|étudier|etudier|étudier|école|ecole|école|école|bureau|jeux|gaming|mon entreprise|ma societe|mon entreprise|ma maison|école|école|école)/i;
const VAGUE_PRODUCT_RE = /^(?:un |une )?(?:ordinateur|laptop|pc|téléphone|telephone|smartphone|casque|imprimante|tablette|appareil|produit|logiciel|service|logiciel)$/i;

/* ---------- Next Best Action (spec §23) ---------- */
const NBA_LABELS = {
  SEND_PRODUCT: "Envoyer des produits adaptés",
  SEND_QUOTE: "Envoyer un devis",
  FOLLOW_UP: "Relancer le prospect",
  CALL_CUSTOMER: "Appeler le client",
  SCHEDULE_MEETING: "Planifier une réunion / démonstration",
  TRANSFER_HUMAN: "Transmettre au conseiller humain",
  ANSWER_OBJECTION: "Traiter l'objection",
  CHECK_STOCK: "Vérifier le réassort / proposer une alternative",
  CREATE_DEAL: "Préparer la commande (transmettre au commercial)",
  WAIT: "Attendre — relance planifiée",
};

/* ---------- Analyse principale ---------- */
export function analyzeLead({ db, org, lead, messages = [], product = null, deal = null, rules = {}, scoringConfig = {} }) {
  const intentScores = { ...INTENT_SCORES_DEFAULT, ...(scoringConfig.intent_scores || {}) };
  const hotMinScore = scoringConfig.hot_min_score ?? 80;
  const hotMinIntent = ["HIGH", "VERY_HIGH"].includes(scoringConfig.hot_min_intent) ? scoringConfig.hot_min_intent : "HIGH";
  const nowMs = Date.now();
  const lastUserMs = messages.filter((m) => m.role === "USER").reduce((mx, m) => Math.max(mx, new Date(m.created_at).getTime()), 0);
  const daysSinceLastUser = lastUserMs ? (nowMs - lastUserMs) / 86400000 : null;

  /* --- Intent score : max des 3 derniers messages user + signaux spéciaux --- */
  const userMsgs = messages.filter((m) => m.role === "USER");
  const recentUser = userMsgs.slice(-3);
  let intentScore = 0;
  let intentConfidence = 50;
  let intentLabel = "curiosité";
  for (const m of recentUser) {
    const meta = safeMeta(m.metadata);
    const text = String(m.content || "");
    let s = intentScores[meta?.intent] ?? intentScores.UNKNOWN;
    let label = meta?.intent || "UNKNOWN";
    // Raffinements textuels (spec §3)
    if (/devis|proposez[- ]moi un devis|proposition commerciale/i.test(text)) { s = Math.max(s, 65); label = "QUOTE"; }
    if (/comment (?:je |se )?payer|modalités? de paiement|modalites de paiement/i.test(text)) { s = Math.max(s, 95); label = "PAYMENT_METHODS"; }
    if (deal && dealProductsCount(db, deal.id) > 0) { s = 100; label = "PURCHASE_CONFIRMED"; }
    if (s > intentScore) { intentScore = s; intentLabel = label; intentConfidence = /devis|payer|acheter|commander|commande/i.test(text) ? 92 : 75; }
  }
  if (deal && dealProductsCount(db, deal.id) > 0) { intentScore = 100; intentLabel = "PURCHASE_CONFIRMED"; intentConfidence = 98; }

  /* --- Engagement score (spec §4) : uniquement données réelles --- */
  const userCount = userMsgs.length;
  let engagement = userCount === 0 ? 0 : userCount <= 2 ? 10 : userCount <= 5 ? 25 : userCount <= 10 ? 40 : 50;
  if (daysSinceLastUser !== null) {
    if (daysSinceLastUser <= 1) engagement += 20;
    else if (daysSinceLastUser <= 3) engagement += 10;
  }
  const assistantCount = messages.filter((m) => m.role === "ASSISTANT").length;
  if (userCount >= 2 && assistantCount >= 1) engagement += 10; // réponses aux questions
  const productsSeen = new Set();
  for (const m of messages) for (const p of safeMeta(m.metadata)?.products || []) productsSeen.add(p);
  if (productsSeen.size >= 2) engagement += 10; // plusieurs produits consultés
  engagement = clamp(engagement);

  /* --- Budget score (spec §5) --- */
  const budget = lead.budget;
  const refPrice = product ? (product.discount_price ?? product.price) : null;
  let budgetScore = 20; // budget inconnu : neutre-bas
  let budgetConfidence = 40;
  let budgetRatio = null;
  let budgetAlternative = false;
  if (budget != null && refPrice) {
    budgetRatio = budget / refPrice;
    budgetScore = budgetRatio >= 1 ? 100 : budgetRatio >= 0.9 ? 85 : budgetRatio >= 0.7 ? 65 : budgetRatio >= 0.5 ? 45 : 25;
    budgetConfidence = 95;
    if (budgetRatio < 1) {
      // Alternative moins chère disponible (spec §5)
      const alt = cheapestInStock(db, org.id, refPrice * budgetRatio, product?.id);
      budgetAlternative = !!alt;
      if (alt) budgetScore = clamp(budgetScore + 10);
    }
  } else if (budget != null && !refPrice) {
    budgetScore = 60; // budget connu, produit non identifié
    budgetConfidence = 70;
  }

  /* --- Need score (spec §6) --- */
  const interest = String(lead.interest || "");
  const productIdentified = !!product;
  const needUsage = NEED_USAGE_RE.test(interest) || userMsgs.slice(-5).some((m) => NEED_USAGE_RE.test(String(m.content || "")));
  const vagueProduct = !productIdentified && VAGUE_PRODUCT_RE.test(interest.trim());
  let needScore = productIdentified ? 65 : vagueProduct ? 40 : 10;
  if (needUsage) needScore += 20;
  if (interest) needScore += 10; // problème/besoin exprimé
  needScore = clamp(needScore);
  const needConfidence = productIdentified ? 85 : vagueProduct ? 60 : 40;

  /* --- Urgency score (spec §7) --- */
  const urgencyTexts = userMsgs.slice(-5).map((m) => String(m.content || "")).join(" ");
  const urgencyMatch = URGENCY_PATTERNS.find((u) => u.re.test(urgencyTexts));
  const urgencyScore = urgencyMatch ? urgencyMatch.score : 10;
  const urgencyConfidence = urgencyMatch ? 90 : 45;

  /* --- Fit score (spec §8) --- */
  let fitScore = 20;
  if (product) {
    const inStock = product.type === "SERVICE" || product.stock_quantity > 0;
    fitScore = inStock ? 60 : 15;
    if (inStock && budgetRatio != null && budgetRatio >= 0.9) fitScore += 25;
    const hasDeliveryInfo = db.prepare("SELECT 1 FROM knowledge_documents WHERE organization_id = ? AND type = 'DELIVERY' AND status = 'READY'").get(org.id);
    if (inStock && hasDeliveryInfo) fitScore += 10;
  }
  fitScore = clamp(fitScore);

  /* --- Objections détectées (dernier message user) + non résolues --- */
  const lastUserText = userMsgs.length ? String(userMsgs[userMsgs.length - 1].content || "") : "";
  const detectedObjections = detectObjections(lastUserText);
  const openObjections = db.prepare(
    `SELECT * FROM objections WHERE organization_id = ? AND lead_id = ? AND resolved = 0 ORDER BY created_at DESC`
  ).all(org.id, lead.id);

  /* --- BANT (spec §13) --- */
  const bant = {
    budget: budget == null ? "UNKNOWN" : budgetRatio == null ? "HIGH" : budgetRatio >= 0.9 ? "CONFIRMED" : budgetRatio >= 0.7 ? "HIGH" : budgetRatio >= 0.5 ? "MEDIUM" : "LOW",
    authority: detectAuthority(lastUserText) || (interest ? "LOW" : "UNKNOWN"),
    need: productIdentified ? (needUsage ? "CONFIRMED" : "HIGH") : vagueProduct ? "MEDIUM" : interest ? "LOW" : "UNKNOWN",
    timeline: urgencyMatch ? urgencyMatch.bant : "UNKNOWN",
  };

  /* --- Score final pondéré (spec §2) --- */
  // Pondération publique (landing / FAQ) : intention 30 · budget 25 · urgence 20 · engagement 15 · adéquation 10
  // « need » est fusionné dans fit (adéquation offre) pour coller aux 5 critères exposés.
  if (!scoringConfig.weights) {
    fitScore = clamp(Math.round(fitScore * 0.55 + needScore * 0.45));
  }
  const weights = scoringConfig.weights || { intent: 0.30, engagement: 0.15, budget: 0.25, need: 0.00, urgency: 0.20, fit: 0.10 };
  const leadScore = clamp(
    intentScore * weights.intent +
    engagement * weights.engagement +
    budgetScore * weights.budget +
    needScore * weights.need +
    urgencyScore * weights.urgency +
    fitScore * weights.fit
  );

  /* --- Purchase intent (spec §11) --- */
  const purchaseIntent =
    leadScore >= 85 && intentScore >= 80 ? "VERY_HIGH" :
    leadScore >= 70 && intentScore >= 65 ? "HIGH" :
    leadScore >= 50 ? "MEDIUM" :
    leadScore >= 30 ? "LOW" : "VERY_LOW";

  /* --- Conversion probability (spec §12) : ESTIMATION heuristique --- */
  const conversionProbability = clamp(0.6 * leadScore + 0.3 * intentScore + 0.1 * engagement);

  /* --- Hot lead (spec §21) --- */
  const hot = leadScore >= hotMinScore && ["HIGH", "VERY_HIGH"].includes(purchaseIntent) && (intentScore >= hotMinScore - 10 || intentScore >= 80);

  /* --- Priority (spec §22) --- */
  const dealValue = deal?.value ?? null;
  const atRisk = detectAtRisk({ lead, messages: userMsgs, deal, openObjections, daysSinceLastUser, leadScore, purchaseIntent, lastMessage: messages[messages.length - 1] || null });
  const priority =
    (atRisk && leadScore >= 60) || (hot && urgencyScore >= 80) ? "URGENT" :
    hot || leadScore >= 75 || (dealValue != null && dealValue >= 1000000 && leadScore >= 60) ? "HIGH" :
    leadScore >= 45 ? "MEDIUM" : "LOW";

  /* --- Estimated value (spec §42) : JAMAIS inventée --- */
  const quantity = Math.max(1, Number(lead.quantity_hint) || 1);
  let estimatedValue = null;
  if (deal?.value != null) estimatedValue = deal.value;
  else if (product) estimatedValue = Math.max(((product.discount_price ?? product.price) || 0) * quantity, 0);

  /* --- Next Best Action (spec §23-24) --- */
  const nba = nextBestAction({ db, lead, product, deal, openObjections, detectedObjections, purchaseIntent, intentScore, budget, budgetRatio, atRisk, urgencyScore, daysSinceLastUser, estimatedValue, rules });

  /* --- Follow-up (spec §33) --- */
  const followUp = recommendFollowUp({ lead, nba, atRisk, daysSinceLastUser, product, product: product, name: lead.name, budget, currency: lead.currency });

  /* --- Deal risk / health (spec §37-38) --- */
  const dealAnalysis = analyzeDeal({ db, org, lead, deal, openObjections, daysSinceLastUser });

  /* --- Raisons explicables (spec §9) --- */
  const reasons = [];
  if (intentScore >= 80) reasons.push({ plus: true, text: `intention d'achat élevée (${intentLabel} — score ${intentScore})` });
  else if (intentScore >= 50) reasons.push({ plus: true, text: `intérêt commercial (${intentLabel} — score ${intentScore})` });
  if (budget != null && budgetRatio != null && budgetRatio >= 0.9) reasons.push({ plus: true, text: "budget compatible avec le produit" });
  else if (budget != null) reasons.push({ plus: budgetScore >= 45, text: `budget identifié (${budgetRatio != null ? Math.round(budgetRatio * 100) + " % du prix" : "produit non identifié"})${budgetAlternative ? " — alternative plus abordable disponible" : ""}` });
  if (productIdentified) reasons.push({ plus: true, text: `produit identifié (${product.name})` });
  if (needUsage) reasons.push({ plus: true, text: "usage / besoin clairement exprimé" });
  if (urgencyMatch) reasons.push({ plus: true, text: `urgence détectée : ${urgencyMatch.label}` });
  if (engagement >= 40) reasons.push({ plus: true, text: `engagement élevé (${userCount} messages, réponse récente)` });
  const negatives = [];
  for (const o of openObjections.slice(0, 3)) negatives.push({ text: `objection ${o.type} non résolue (sévérité ${o.severity})` });
  if (product && product.type !== "SERVICE" && product.stock_quantity <= 0) negatives.push({ text: `produit « ${product.name} » en rupture de stock` });
  if (budgetRatio != null && budgetRatio < 0.5) negatives.push({ text: "budget nettement inférieur au prix du produit" });
  if (atRisk) negatives.push({ text: "aucune réponse récente — risque de perte" });
  for (const o of detectedObjections) if (!openObjections.some((x) => x.type === o.type && x.created_at.slice(0, 10) === now().slice(0, 10))) negatives.push({ text: `nouvelle objection détectée : ${o.type} (${o.severity})` });

  return {
    dimensions: {
      intent: { score: intentScore, confidence: intentConfidence, label: intentLabel },
      engagement: { score: engagement, confidence: 80 },
      budget: { score: budgetScore, confidence: budgetConfidence, ratio: budgetRatio, alternative: budgetAlternative },
      need: { score: needScore, confidence: needConfidence, product: product?.name || null, usage: needUsage },
      urgency: { score: urgencyScore, confidence: urgencyConfidence, label: urgencyMatch?.label || null },
      fit: { score: fitScore, confidence: 75 },
    },
    lead_score: leadScore,
    reasons,
    negatives,
    purchase_intent: purchaseIntent,
    conversion_probability: conversionProbability,
    bant,
    priority,
    hot,
    at_risk: atRisk,
    estimated_value: estimatedValue,
    next_best_action: nba.action,
    next_best_action_label: NBA_LABELS[nba.action],
    next_best_action_reason: nba.reason,
    follow_up: followUp,
    deal: dealAnalysis,
    detected_objections: detectedObjections,
    open_objections: openObjections,
    products_seen: [...productsSeen],
    confidence: clamp(0.4 * intentConfidence + 0.2 * budgetConfidence + 0.2 * needConfidence + 0.1 * urgencyConfidence + 0.1 * 80),
  };
}

/* ---------- Détections ---------- */
function detectObjections(text) {
  const out = [];
  const critical = CRITICAL_RE.test(text);
  for (const p of OBJECTION_PATTERNS) {
    if (p.re.test(text)) out.push({ type: p.type, severity: critical ? "CRITICAL" : p.severity, confidence: critical ? 95 : p.conf, text: text.slice(0, 200), competitor_name: detectCompetitor(text) });
  }
  if (critical && !out.length) out.push({ type: "OTHER", severity: "CRITICAL", confidence: 95, text: text.slice(0, 200), competitor_name: null });
  return out;
}

function detectCompetitor(text) {
  const t = String(text).toLowerCase();
  for (const c of KNOWN_COMPETITORS) if (t.includes(c)) return c;
  const m = t.match(/(?:marque|fournisseur|chez) ([a-z]{3,20})/);
  return m ? m[1] : null;
}

function detectAuthority(text) {
  for (const p of AUTHORITY_PATTERNS) if (p.re.test(text)) return p.score;
  return null;
}

function detectAtRisk({ lead, messages, deal, openObjections, daysSinceLastUser, leadScore, purchaseIntent, lastMessage }) {
  if (daysSinceLastUser == null) return false;
  const hotEnough = leadScore >= 60 || ["HIGH", "VERY_HIGH"].includes(purchaseIntent) || lead.hot === 1;
  if (!hotEnough) return false;
  // Lead chaud + aucune réponse depuis plusieurs jours
  if (daysSinceLastUser >= 3 && !lead.next_followup_at) return true;
  // Forte intention + conversation abandonnée (dernier message de la conversation = assistant)
  if (["HIGH", "VERY_HIGH"].includes(purchaseIntent) && daysSinceLastUser >= 2 && lastMessage && lastMessage.role !== "USER") return true;
  // Devis/proposition + aucune réponse depuis 5 jours
  if (deal && ["PROPOSAL", "NEGOTIATION"].includes(deal.stage) && daysSinceLastUser >= 5) return true;
  return false;
}

/* ---------- Next Best Action ---------- */
function nextBestAction({ db, lead, product, deal, openObjections, detectedObjections, purchaseIntent, intentScore, budget, budgetRatio, atRisk, urgencyScore, daysSinceLastUser, estimatedValue, rules }) {
  const critical = openObjections.some((o) => o.severity === "CRITICAL") || detectedObjections.some((o) => o.severity === "CRITICAL");
  if (critical) return { action: "TRANSFER_HUMAN", reason: "Objection critique détectée — transmission au conseiller pour traitement personnalisé." };
  const openHigh = openObjections.find((o) => o.severity === "HIGH" || o.severity === "MEDIUM");
  if (openHigh) return { action: "ANSWER_OBJECTION", reason: `Objection ${openHigh.type} (${openHigh.severity}) non résolue — y répondre avant de progresser.` };
  // Lead at-risk : la priorité absolue est de relancer avant de perdre le prospect
  if (atRisk) return { action: "FOLLOW_UP", reason: "Lead chaud sans réponse récente — relancer rapidement pour éviter la perte." };
  if (deal && dealProductsCount(db, deal.id) > 0) return { action: "CREATE_DEAL", reason: "Achat confirmé (deal avec lignes produits) — préparer la commande et transmettre au commercial." };
  if (["VERY_HIGH", "HIGH"].includes(purchaseIntent) && budget != null && product) {
    if (product.type === "SERVICE" || product.stock_quantity > 0) return { action: "CREATE_DEAL", reason: `Intention forte, budget confirmé (${fmtShort(budget)}) et produit « ${product.name} » disponible — préparer la commande / transmettre au commercial (paiement non encore implémenté).` };
    return { action: "CHECK_STOCK", reason: `Intention forte et budget confirmé, mais « ${product.name} » est en rupture — vérifier le réassort et proposer une alternative.` };
  }
  if (product && (budget == null || (budgetRatio != null && budgetRatio < 1))) {
    if (budget != null && budgetRatio < 0.5) return { action: "SEND_PRODUCT", reason: `Budget (${fmtShort(budget)} nettement en dessous du prix — envoyer des produits adaptés au budget.` };
    if (budget == null) return { action: "FOLLOW_UP", reason: "Poser la question du budget avant de proposer un devis." };
    return { action: "SEND_QUOTE", reason: `Produit « ${product.name} » identifié et budget compatible à ${Math.round((budgetRatio || 0) * 100)} % du prix — envoyer un devis.` };
  }
  if (urgencyScore >= 80) return { action: "CALL_CUSTOMER", reason: "Urgence élevée exprimée — appeler rapidement pour sécuriser la vente." };
  if (intentScore >= 65) return { action: "SCHEDULE_MEETING", reason: "Intention commerciale forte — planifier une démonstration ou un rendez-vous." };
  if (daysSinceLastUser != null && daysSinceLastUser < 2) return { action: "WAIT", reason: "Conversation récente — attendre puis relancer dans 2-3 jours si besoin." };
  return { action: "FOLLOW_UP", reason: "Relancer le prospect pour faire avancer la qualification." };
}

function fmtShort(n) {
  try { return `${new Intl.NumberFormat("fr-FR").format(Math.round(n))} FCFA`; } catch { return `${Math.round(n)}`; }
}

function recommendFollowUp({ lead, nba, atRisk, daysSinceLastUser, product, name, budget, currency }) {
  if (!["FOLLOW_UP", "CALL_CUSTOMER", "SCHEDULE_MEETING", "WAIT"].includes(nba.action)) return null;
  const days = atRisk ? 1 : 3;
  const at = new Date(Date.now() + days * 86400000);
  const when = at.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const productName = product?.name ? ` le ${product.name}` : "";
  const budgetPart = budget != null ? ` (budget ~${fmtShort(budget)})` : "";
  const message = `Bonjour ${name || "au client"}, je reviens vers vous concernant${productName}${budgetPart}. N'hésitez pas si vous avez des questions — je reste à votre disposition.`;
  return { at: at.toISOString(), when: `Relancer ${when}`, message };
}

function analyzeDeal({ db, org, lead, deal, openObjections, daysSinceLastUser }) {
  if (!deal) return null;
  const riskFactors = [];
  let risk = "LOW";
  if (daysSinceLastUser != null && daysSinceLastUser >= 7) { riskFactors.push("aucune réponse depuis plusieurs jours"); risk = "MEDIUM"; }
  if (openObjections.some((o) => o.severity === "HIGH" || o.severity === "CRITICAL")) { riskFactors.push("objection majeure non résolue"); risk = "HIGH"; }
  if (deal.probability <= 30) { riskFactors.push("probabilité faible"); if (risk === "LOW") risk = "MEDIUM"; }
  if (daysSinceLastUser != null && daysSinceLastUser >= 14) risk = "HIGH";
  let health;
  if (deal.stage === "WON") health = "Won";
  else if (deal.stage === "LOST") health = "Lost";
  else if (daysSinceLastUser != null && daysSinceLastUser >= 10) health = "Stalled";
  else if (risk === "HIGH" || risk === "MEDIUM") health = "At Risk";
  else health = "Healthy";
  return { id: deal.id, stage: deal.stage, value: deal.value, probability: deal.probability, risk, risk_factors: riskFactors, health };
}

function safeMeta(m) {
  if (!m) return null;
  if (typeof m === "object") return m;
  try { return JSON.parse(m); } catch { return null; }
}

function dealProductsCount(dbOrNull, dealId) {
  if (!dbOrNull || !dealId) return 0;
  return dbOrNull.prepare("SELECT COUNT(*) AS n FROM deal_products WHERE deal_id = ?").get(dealId).n;
}

function cheapestInStock(db, orgId, maxPrice, excludeProductId) {
  const p = db.prepare(
    `SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE' AND type = 'PRODUCT'
     AND (COALESCE(discount_price, price)) <= ? AND id != ? AND stock_quantity > 0
     ORDER BY (COALESCE(discount_price, price)) ASC LIMIT 1`
  ).get(orgId, maxPrice, excludeProductId || "none");
  return p;
}

/* ---------- Persistance : refresh du lead (auto-actions non sensibles) ---------- */
export function refreshLead(ctx, leadId) {
  const { db, org, user } = ctx;
  const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, org.id);
  if (!lead) return null;
  // Conversation principale : celle liée au lead (la plus récente)
  const conv = db.prepare("SELECT * FROM conversations WHERE lead_id = ? AND organization_id = ? ORDER BY updated_at DESC LIMIT 1").get(leadId, org.id);
  const messages = conv
    ? db.prepare("SELECT role, content, metadata, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200").all(conv.id)
    : [];
  const deal = db.prepare("SELECT * FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId, org.id) || null;
  const product = productForLead(db, org.id, lead, deal);
  const rules = db.prepare("SELECT * FROM sales_rules WHERE organization_id = ?").get(org.id) || {};
  const analysis = analyzeLead({ db, org, lead, messages, product, deal, rules });

  // Objections / buying signals du dernier message (dédupliqués sur 24h)
  const lastUserText = messages.filter((m) => m.role === "USER").slice(-1).map((m) => String(m.content || ""))[0] || "";
  const since24h = new Date(Date.now() - 86400000).toISOString();
  for (const o of analysis.detected_objections) {
    const dup = db.prepare(
      "SELECT 1 FROM objections WHERE organization_id = ? AND lead_id = ? AND type = ? AND severity = ? AND created_at > ?"
    ).get(org.id, leadId, o.type, o.severity, since24h);
    if (!dup) {
      db.prepare(
        `INSERT INTO objections (id, organization_id, lead_id, conversation_id, type, text, severity, resolved, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(randomUUID(), org.id, leadId, conv?.id || null, o.type, o.text, o.severity, JSON.stringify({ confidence: o.confidence, competitor_name: o.competitor_name }), now());
    }
  }
  for (const s of detectBuyingSignals(lastUserText)) {
    const dup = db.prepare("SELECT 1 FROM buying_signals WHERE organization_id = ? AND lead_id = ? AND type = ? AND created_at > ?").get(org.id, leadId, s.type, since24h);
    if (!dup) {
      db.prepare(
        `INSERT INTO buying_signals (id, organization_id, lead_id, conversation_id, type, confidence, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), org.id, leadId, conv?.id || null, s.type, s.confidence, lastUserText.slice(0, 200), now());
    }
  }

  // Historique du score (si changement significatif)
  const previous = lead.score ?? 0;
  const change = analysis.lead_score - previous;
  if (Math.abs(change) >= 5) {
    const reason = (analysis.reasons.find((r) => r.plus)?.text || "analyse smart sales") +
      (analysis.negatives.length ? " ; " + analysis.negatives.map((n) => n.text).join("; ") : "");
    db.prepare(
      `INSERT INTO lead_score_history (id, organization_id, lead_id, score, previous_score, change, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'smart_engine', ?)`
    ).run(randomUUID(), org.id, leadId, analysis.lead_score, previous, change, reason.slice(0, 500), now());
    logActivity(ctx, leadId, "NOTE", `Smart Sales Engine : score ${previous} → ${analysis.lead_score} (${analysis.purchase_intent})`);
    logAudit(db, { organizationId: org.id, userId: user?.id || null, action: "TOOL_CALL", resourceType: "lead", resourceId: leadId, metadata: { tool: "smart_engine", from: previous, to: analysis.lead_score } });
  }

  // Mise à jour du lead
  db.prepare(
    `UPDATE leads SET score = ?, purchase_intent = ?, conversion_probability = ?, bant_budget = ?, bant_authority = ?, bant_need = ?, bant_timeline = ?,
     priority = ?, hot = ?, at_risk = ?, estimated_value = ?, next_best_action = ?, next_best_action_reason = ?,
     next_followup_at = COALESCE(?, next_followup_at), follow_up_message = ?, conversation_id = COALESCE(?, conversation_id),
     last_contact_at = COALESCE(?, last_contact_at), updated_at = ? WHERE id = ?`
  ).run(
    analysis.lead_score, analysis.purchase_intent, analysis.conversion_probability,
    analysis.bant.budget, analysis.bant.authority, analysis.bant.need, analysis.bant.timeline,
    analysis.priority, analysis.hot ? 1 : 0, analysis.at_risk ? 1 : 0, analysis.estimated_value,
    analysis.next_best_action, analysis.next_best_action_reason.slice(0, 500),
    analysis.follow_up?.at || null, analysis.follow_up?.message || null, conv?.id || null,
    conv ? new Date(messages.filter((m) => m.role === "USER").slice(-1)[0]?.created_at || 0).toISOString() : null,
    now(), leadId
  );

  // Tâche de suivi automatique (si at-risk et NBA = FOLLOW_UP, sans doublon)
  if (analysis.at_risk && analysis.next_best_action === "FOLLOW_UP") {
    const existing = db.prepare("SELECT 1 FROM tasks WHERE organization_id = ? AND lead_id = ? AND status IN ('TODO','IN_PROGRESS') AND title LIKE ?").get(org.id, leadId, "Suivi IA:%");
    if (!existing) {
      db.prepare(
        `INSERT INTO tasks (id, organization_id, assigned_to, lead_id, title, description, priority, status, due_date, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'HIGH', 'TODO', ?, ?, ?, ?)`
      ).run(randomUUID(), org.id, lead.assigned_to, leadId, `Suivi IA : ${lead.name}`,
        `Lead at-risk (score ${analysis.lead_score}). ${analysis.next_best_action_reason}${analysis.follow_up?.message ? "\n\nMessage suggéré : " + analysis.follow_up.message : ""}`,
        analysis.follow_up?.at?.slice(0, 10) || null, user?.id || null, now(), now());
    }
  }

  // Phase 5 : transitions (hot/cold, at-risk) + prédiction (features immuables)
  try {
    const fev = (type, payload) => { try { const ev = emitEvent(db, org.id, { type, entity_type: "lead", entity_id: leadId, lead_id: leadId, payload }); processEvent(db, ev); } catch {} };
    const wasHot = !!lead.hot, isHot = !!analysis.hot;
    if (!wasHot && isHot) fev("LEAD_BECAME_HOT", { reason: `score ${analysis.lead_score}, intention ${analysis.purchase_intent}` });
    if (wasHot && !isHot) fev("LEAD_BECAME_COLD", { reason: `score ${analysis.lead_score}` });
    if (!lead.at_risk && analysis.at_risk) fev("NO_RESPONSE", { reason: analysis.next_best_action_reason, score: analysis.lead_score });
    if (analysis.deal && analysis.deal.risk !== "LOW") {
      const recentDealRisk = db.prepare("SELECT 1 n FROM sales_events WHERE organization_id = ? AND type = 'DEAL_AT_RISK' AND created_at > datetime('now', '-1 day') AND payload LIKE ? LIMIT 1").get(org.id, `%${analysis.deal.id}%`);
      if (!recentDealRisk) fev("DEAL_AT_RISK", { deal_id: analysis.deal.id, risk: analysis.deal.risk, factors: analysis.deal.risk_factors });
    }
    // Notifications internes (hot / urgent / at-risk) — dédup 24h côté notifications
    const targets = (lead.assigned_to ? [lead.assigned_to] : notifiableMembers(db, org.id).map((m) => m.user_id));
    for (const uid of targets) {
      if (!wasHot && isHot) notifyUser(db, { orgId: org.id, userId: uid, type: "HOT_LEAD", title: `Lead chaud : ${lead.name}`, message: `Score ${analysis.lead_score}/100 — ${analysis.next_best_action_reason}`, link: `/dashboard/leads/${leadId}`, leadId });
      if (analysis.priority === "URGENT") notifyUser(db, { orgId: org.id, userId: uid, type: "URGENT_LEAD", title: `Lead urgent : ${lead.name}`, message: analysis.next_best_action_reason, link: `/dashboard/leads/${leadId}`, leadId });
      if (!lead.at_risk && analysis.at_risk) notifyUser(db, { orgId: org.id, userId: uid, type: "DEAL_AT_RISK", title: `Lead à risque : ${lead.name}`, message: "Sans réponse récente — relance recommandée.", link: `/dashboard/leads/${leadId}`, leadId });
    }
    // Prédiction : snapshot immuable des features au moment de la décision
    const lastPred = db.prepare("SELECT id FROM sales_prediction_events WHERE organization_id = ? AND lead_id = ? AND (actual_outcome IS NULL OR actual_outcome = 'UNKNOWN') ORDER BY created_at DESC LIMIT 1").get(org.id, leadId);
    const lastPredRow = lastPred ? db.prepare("SELECT * FROM sales_prediction_events WHERE id = ?").get(lastPred.id) : null;
    const valueChanged = !lastPredRow || Math.abs((lastPredRow.prediction_value ?? 0) - (analysis.conversion_probability ?? 0)) >= 1;
    if (valueChanged) {
      const conv = db.prepare("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.lead_id = ? AND m.role = 'USER'").get(leadId).n;
      logPrediction(db, org.id, { ...lead, id: leadId }, { ...analysis, response_count: conv, days_since_created: Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400e3) }, deal);
    }
  } catch { /* non bloquant */ }

  return { ...lead, score: analysis.lead_score, ...analysis, lead_row: db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) };
}

function logActivity(ctx, leadId, type, description) {
  ctx.db.prepare(
    `INSERT INTO activities (id, organization_id, lead_id, user_id, type, description, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)`
  ).run(randomUUID(), ctx.org.id, leadId, type, description.slice(0, 500), now());
}

export function detectBuyingSignals(text) {
  const out = [];
  for (const p of BUYING_SIGNALS) if (p.re.test(text)) out.push({ type: p.type, confidence: p.conf, text: String(text).slice(0, 200) });
  return out;
}

function productForLead(db, orgId, lead, deal) {
  // Produit via deal (lignes produits)
  if (deal) {
    const line = db.prepare(
      `SELECT p.* FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ? AND p.organization_id = ? ORDER BY dp.total DESC LIMIT 1`
    ).get(deal.id, orgId);
    if (line) return line;
  }
  // Produit via intérêt : correspondance par nom dans le catalogue
  const interest = String(lead.interest || "").toLowerCase();
  if (interest.length >= 3) {
    const rows = db.prepare("SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE'").all(orgId);
    const match = rows.find((p) => interest.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(interest));
    if (match) return match;
  }
  return null;
}

/* ---------- Résumé commercial structuré (spec §28) ---------- */
export function conversationSummaryV2({ analysis, lead, deal, customer, messages = [], buyingSignals = [] }) {
  const userMsgs = messages.filter((m) => m.role === "USER");
  return {
    customer: customer ? `${customer.first_name} ${customer.last_name}${customer.company_name ? " — " + customer.company_name : ""}` : lead.name,
    need: analysis.dimensions.need.usage ? "besoin clairement exprimé" : lead.interest || analysis.dimensions.need.product || "non précisé",
    budget: lead.budget != null ? `${lead.budget} FCFA` : "non identifié",
    product: analysis.dimensions.need.product || deal?.name || null,
    timeline: analysis.bant.timeline,
    authority: analysis.bant.authority,
    objections: analysis.open_objections.map((o) => `${o.type} (${o.severity})`),
    buying_signals: buyingSignals.map((s) => s.type),
    intent: analysis.purchase_intent,
    lead_score: analysis.lead_score,
    next_best_action: analysis.next_best_action_label,
    messages_count: messages.length,
    user_messages: userMsgs.length,
  };
}

/* ---------- Coach IA (spec §36) : analyse pour le commercial humain ---------- */
export function salesCoachAnalysis(analysis, lead, deal, openObjections) {
  const strengths = analysis.reasons.filter((r) => r.plus).map((r) => r.text);
  const risks = [...analysis.negatives.map((n) => n.text)];
  if (analysis.deal?.risk && analysis.deal.risk !== "LOW") risks.push(`deal ${analysis.deal.risk.toLowerCase()} : ${analysis.deal.risk_factors.join(", ")}`);
  const opportunity = analysis.estimated_value != null
    ? `Valeur potentielle : ${new Intl.NumberFormat("fr-FR").format(analysis.estimated_value)} FCFA (probabilité estimée ${analysis.conversion_probability} %).`
    : "Valeur à préciser selon le produit visé.";
  const summary = `Le prospect est ${analysis.purchase_intent === "VERY_HIGH" ? "très fortement intéressé" : analysis.purchase_intent === "HIGH" ? "fortement intéressé" : analysis.purchase_intent === "MEDIUM" ? "intéressé" : "en cours de qualification"} (score ${analysis.lead_score}/100)${analysis.dimensions.budget.ratio != null ? `, budget ${Math.round(analysis.dimensions.budget.ratio * 100)} % du prix du produit` : " sans budget confirmé"}.${openObjections.length ? ` ${openObjections.length} objection(s) non résolue(s).` : " Aucune objection ouverte."}`;
  return {
    summary,
    strengths,
    objections: openObjections.map((o) => `${o.type} — ${o.severity}`),
    risks,
    opportunity,
    recommended_action: analysis.next_best_action_label,
    recommended_action_reason: analysis.next_best_action_reason,
  };
}

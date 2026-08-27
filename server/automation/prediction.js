// server/automation/prediction.js — Phase 5 : fondation de scoring data-driven
// (spec §35-44). Le score de Phase 4 est une ESTIMATION HEURISTIQUE — jamais
// présenté comme un modèle ML. Cette couche collecte : features au moment de la
// prédiction (snapshot IMMUTABLE), résultats réels (WON/LOST), et mesure la
// maturité du dataset avant toute expérimentation ML.

import { randomUUID } from "node:crypto";

/**
 * PredictionProvider (spec §39) : abstraction HEURISTIC | ML.
 * Phase 5 : HEURISTIC par défaut. ML est DISABLED tant qu'aucun modèle
 * EXPERIMENTAL/ACTIVE n'existe — et aucun modèle ML n'est entraîné dans cette phase.
 */
export function getPredictionProvider(db, orgId) {
  const model = db.prepare(
    "SELECT * FROM prediction_models WHERE organization_id = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1"
  ).get(orgId) || null;
  return {
    mode: model ? "ML" : "HEURISTIC",
    model: model ? { id: model.id, type: model.model_type, version: model.version } : null,
    label: model ? "ML PREDICTION" : "HEURISTIC ESTIMATE",
  };
}

/**
 * Enregistre une prédiction avec un snapshot des features AU MOMENT de la décision
// (spec §38). Les snapshots ne sont jamais modifiés rétroactivement (spec §55).
 */
export function logPrediction(db, orgId, lead, analysis, deal = null) {
  const dims = analysis.dimensions || {};
  const features = {
    lead_score: analysis.lead_score ?? null,
    intent: analysis.dimensions?.intent?.label ?? null,
    intent_score: dims.intent?.score ?? null,
    engagement: dims.engagement?.score ?? null,
    budget: lead.budget ?? null,
    budget_ratio: dims.budget?.ratio ?? null,
    urgency: dims.urgency?.score ?? null,
    need: dims.need?.score ?? null,
    fit: dims.fit?.score ?? null,
    deal_value: deal?.value ?? lead.estimated_value ?? null,
    source: lead.source ?? null,
    product: analysis.dimensions?.need?.product ?? lead.interest ?? null,
    response_count: analysis.response_count ?? null,
    days_since_created: analysis.days_since_created ?? null,
    hot: !!lead.hot,
    at_risk: !!lead.at_risk,
    bant: analysis.bant ?? null,
    purchase_intent: analysis.purchase_intent ?? null,
  };
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sales_prediction_events (id, organization_id, lead_id, prediction_type, prediction_value, prediction_confidence, features_snapshot, actual_outcome, created_at)
     VALUES (?, ?, ?, 'CONVERSION', ?, ?, ?, 'UNKNOWN', ?)`
  ).run(id, orgId, lead.id, analysis.conversion_probability ?? null, analysis.confidence ?? null, JSON.stringify(features), now);
  return db.prepare("SELECT * FROM sales_prediction_events WHERE id = ?").get(id);
}

/**
 * Résout le résultat réel d'un lead (spec §37) : WON/LOST — uniquement les
// résultats FINALISÉS. Les deals ouverts restent UNKNOWN (jamais de label faux).
 */
export function resolveOutcome(db, orgId, leadId, outcome) {
  if (!["WON", "LOST"].includes(outcome)) return null;
  const ev = db.prepare(
    "SELECT * FROM sales_prediction_events WHERE organization_id = ? AND lead_id = ? AND (actual_outcome IS NULL OR actual_outcome = 'UNKNOWN') ORDER BY created_at DESC LIMIT 1"
  ).get(orgId, leadId);
  if (!ev) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE sales_prediction_events SET actual_outcome = ?, resolved_at = ? WHERE id = ?").run(outcome, now, ev.id);
  return { id: ev.id, actual_outcome: outcome, resolved_at: now };
}

/**
 * AI Prediction Readiness (spec §40) : état du dataset.
// Le seuil est CONFIGURABLE par organisation (settings.ml_min_resolved) —
// jamais présenté comme une vérité universelle.
 */
export function predictionReadiness(db, org) {
  const orgId = org.id;
  const settings = org.settings ? JSON.parse(org.settings) : {};
  const minResolved = Math.max(10, Number(settings.ml_min_resolved) || 100);
  const leads = db.prepare("SELECT COUNT(*) n FROM leads WHERE organization_id = ?").get(orgId).n;
  const deals = db.prepare("SELECT COUNT(*) n FROM deals WHERE organization_id = ?").get(orgId).n;
  const won = db.prepare("SELECT COUNT(*) n FROM deals WHERE organization_id = ? AND stage = 'WON'").get(orgId).n;
  const lost = db.prepare("SELECT COUNT(*) n FROM deals WHERE organization_id = ? AND stage = 'LOST'").get(orgId).n;
  const predictions = db.prepare("SELECT COUNT(*) n FROM sales_prediction_events WHERE organization_id = ?").get(orgId).n;
  const resolved = db.prepare("SELECT COUNT(*) n FROM sales_prediction_events WHERE organization_id = ? AND actual_outcome IN ('WON','LOST')").get(orgId).n;
  const ready = resolved >= minResolved && leads >= minResolved;
  const provider = getPredictionProvider(db, orgId);
  return {
    mode: provider.mode,
    label: provider.label,
    dataset: { leads, deals, won, lost, open_deals: deals - won - lost, predictions, resolved_predictions: resolved },
    min_required: minResolved,
    min_required_note: "Seuil configurable par organisation (settings.ml_min_resolved) — indicatif, pas une vérité universelle.",
    ready,
    status: ready ? "Dataset prêt pour expérimentation ML" : "Dataset encore insuffisant",
    missing: !ready ? [
      resolved < minResolved ? `Résultats finalisés manquants : ${resolved}/${minResolved}` : null,
      leads < minResolved ? `Leads manquants : ${leads}/${minResolved}` : null,
    ].filter(Boolean) : [],
    disclaimer: provider.mode === "HEURISTIC"
      ? "Les scores actuels sont des HEURISTIC ESTIMATES (règles explicables), pas des prédictions ML."
      : null,
  };
}

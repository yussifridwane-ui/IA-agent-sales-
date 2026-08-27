// server/automation/followup.js — Phase 5 : moteur de suivi intelligent
// WHEN to follow up (business hours + timezone), WHAT to say (templates +
// génération IA sans fausse urgence/remise/dispo/garantie), limits anti-spam.

import { randomUUID } from "node:crypto";

/* ---------- Délais (spec §8) : immédiat / 5m / 15m / 1h / 1j / 2j / 3j / 7j / personnalisé ---------- */
const WAIT_RE = /^(\d+)([smhd])$/i;
const WAIT_PRESET = {
  immediate: 0, now: 0,
  "5m": 5 * 60e3, "15m": 15 * 60e3, "1h": 3600e3,
  "1d": 86400e3, "2d": 2 * 86400e3, "3d": 3 * 86400e3, "7d": 7 * 86400e3,
};

/** Parse un délai → millisecondes (null si invalide). */
export function parseWait(wait) {
  const w = String(wait || "immediate").trim().toLowerCase();
  if (WAIT_PRESET[w] !== undefined) return WAIT_PRESET[w];
  const m = WAIT_RE.exec(w);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return n * unit;
}

/* ---------- Timezone (spec §26) : stocker en UTC, calculer dans le TZ de l'org ---------- */

function zonedParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: parts.weekday, // Mon, Tue, ...
  };
}

const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Business hours (spec §25) : si l'heure planifiée tombe hors horaires,
 * la décaler au prochain créneau ouvré (dans le timezone de l'organisation).
 * Retourne la date en UTC (ISO).
 */
export function nextBusinessSlot(fromMs, { timezone = "UTC", days = [1, 2, 3, 4, 5], open = 8 * 60, close = 18 * 60 } = {}) {
  let ms = fromMs;
  for (let i = 0; i < 30; i++) { // borné : max 30 itérations (jamais de boucle infinie)
    const p = zonedParts(ms, timezone);
    const dow = WEEKDAY_IDX[p.weekday];
    const mins = p.hour * 60 + p.minute + p.second / 60;
    const openDay = days.includes(dow) && mins >= open && mins < close;
    if (openDay) return new Date(ms).toISOString();
    // Déplacer à l'ouverture du jour ouvré suivant (ou du même jour si avant l'ouverture)
    let nextDow = dow, nextDayOffset = 0;
    if (!days.includes(dow)) { nextDayOffset = 1; }
    else if (mins < open) { nextDayOffset = 0; }
    else { nextDayOffset = 1; }
    for (let o = nextDayOffset; o < nextDayOffset + 8; o++) {
      const candDow = (dow + o) % 7;
      if (days.includes(candDow)) { nextDow = candDow; break; }
    }
    const base = Date.UTC(p.year, p.month - 1, p.day + nextDayOffset);
    ms = base + (nextDow - new Date(base).getUTCDay() + 7) % 7 * 86400e3 + (open * 60 - p.second) * 1e3;
    if (nextDayOffset === 0) ms = base + open * 60e3; // même jour : à l'ouverture
  }
  return new Date(fromMs).toISOString(); // fallback sûr (borné)
}

/* ---------- Templates (spec §15) : variables + échappement ---------- */
export const TEMPLATE_VARS = ["first_name", "product_name", "company_name", "deal_value", "sales_agent"];

/**
 * Rendu d'un message avec variables {{...}}. Seules les variables connues sont
 * substituées (les autres sont laissées telles quelles — jamais de donnée inventée).
 * Les valeurs sont échappées pour un rendu HTML (le frontend échappe aussi).
 */
export function renderTemplate(db, orgId, { template_id = null, subject = null, content = null }, vars) {
  let subj = subject, body = content;
  if (template_id) {
    const t = db.prepare("SELECT * FROM message_templates WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'").get(template_id, orgId);
    if (t) { subj = subj ?? t.subject; body = body ?? t.content; }
  }
  const escape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const replace = (text) => String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, name) => {
    const k = name.toLowerCase();
    return TEMPLATE_VARS.includes(k) && vars[k] != null ? escape(vars[k]) : m;
  });
  return { subject: subj ? replace(subj) : null, content: body ? replace(body) : "" };
}

/** Contexte de variables d'un lead (jamais de valeur inventée). */
export function templateVars(db, orgId, lead, { product = null, deal = null, salesAgentName = null } = {}) {
  const customer = lead.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(lead.customer_id, orgId) : null;
  const firstName = customer?.first_name || String(lead.name || "").split(/\s+/)[0] || "";
  return {
    first_name: firstName,
    product_name: product?.name || lead.interest || "",
    company_name: lead.company_name || customer?.company_name || "",
    deal_value: deal?.value != null ? `${Number(deal.value).toLocaleString("fr-FR")} ${lead.currency || "FCFA"}` : "",
    sales_agent: salesAgentName || "",
  };
}

/* ---------- Générateur IA de follow-up (spec §16) — local, déterministe ----------
   Ne génère JAMAIS : fausse urgence, fausse remise, fausse disponibilité,
   fausse garantie, fausse preuve sociale. Les mentions de stock sont
   vérifiées sur le catalogue (source de vérité). */
export function generateFollowUpMessage({ lead, product = null, deal = null, objection = null, agentName = null, currency = "FCFA" }) {
  const first = lead.name ? String(lead.name).split(/\s+/)[0] : "cher client";
  const productPart = product ? ` le ${product.name}` : lead.interest ? ` ${lead.interest}` : " votre demande";
  let body = `Bonjour ${first}, je reviens vers vous concernant${productPart}.`;
  if (deal && deal.value != null && ["PROPOSAL", "NEGOTIATION"].includes(deal.stage)) {
    body += ` Nous vous avions transmis une proposition de ${Number(deal.value).toLocaleString("fr-FR")} ${currency}.`;
  }
  if (objection) {
    const answers = {
      PRICE: " Si le budget est un point de discussion, je peux vous présenter des alternatives adaptées.",
      QUALITY: " N'hésitez pas si vous avez des questions sur la qualité ou les garanties constructeur.",
      DELIVERY: " Je peux vous préciser les délais de livraison pour votre zone.",
      PAYMENT: " Je peux vous présenter les modes de paiement disponibles.",
      TRUST: " Je reste à votre disposition pour tout élément complémentaire avant votre décision.",
    };
    body += answers[objection.type] || " Je reste à votre disposition pour répondre à vos questions.";
  } else if (product && product.stock_quantity > 0) {
    body += " Le produit est actuellement disponible — je reste disponible si vous souhaitez avancer.";
  } else {
    body += " Je reste disponible si vous avez des questions.";
  }
  if (agentName) body += ` — ${agentName}`;
  return body.slice(0, 600);
}

/* ---------- Anti-spam (spec §11) : limites par organisation ---------- */
export function getLimits(db, orgId) {
  return db.prepare("SELECT * FROM communication_limits WHERE organization_id = ?").get(orgId)
    || { organization_id: orgId, max_per_day: 2, max_per_week: 5, min_interval_minutes: 60, max_followups: 4 };
}

/**
 * Vérifie les limites anti-spam pour un contact (lead). Renvoie { ok, reason }.
 * Compte les envois TENTÉS (sent ou failed) — jamais d'excès même en cas d'échec.
 */
export function checkCommunicationLimits(db, orgId, leadId) {
  const limits = getLimits(db, orgId);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86400e3).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86400e3).toISOString();
  const perDay = db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SENT','FAILED') AND created_at > ?").get(orgId, leadId, dayAgo).n;
  if (perDay >= limits.max_per_day) return { ok: false, reason: `Limite quotidienne atteinte (${limits.max_per_day}/jour).` };
  const perWeek = db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SENT','FAILED') AND created_at > ?").get(orgId, leadId, weekAgo).n;
  if (perWeek >= limits.max_per_week) return { ok: false, reason: `Limite hebdomadaire atteinte (${limits.max_per_week}/semaine).` };
  const last = db.prepare("SELECT created_at FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SENT','FAILED') ORDER BY created_at DESC LIMIT 1").get(orgId, leadId);
  if (last && (now.getTime() - new Date(last.created_at).getTime()) / 60e3 < limits.min_interval_minutes) {
    return { ok: false, reason: `Intervalle minimum non respecté (${limits.min_interval_minutes} min).` };
  }
  const totalFollowups = db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SENT','FAILED') AND created_at > ?").get(orgId, leadId, "2000-01-01T00:00:00.000Z").n;
  if (totalFollowups >= limits.max_followups) return { ok: false, reason: `Nombre maximum de follow-ups atteint (${limits.max_followups}).` };
  return { ok: true, reason: null };
}

/* ---------- Opt-out (spec §12) ---------- */
/** Préférences de communication d'un lead (row lead, sinon customer). */
export function getPreferences(db, orgId, lead) {
  let prefs = lead.id ? db.prepare("SELECT * FROM communication_preferences WHERE organization_id = ? AND lead_id = ?").get(orgId, lead.id) : null;
  if (!prefs && lead.customer_id) prefs = db.prepare("SELECT * FROM communication_preferences WHERE organization_id = ? AND customer_id = ?").get(orgId, lead.customer_id);
  return prefs || { email: 1, sms: 1, whatsapp: 1, marketing: 1, transactional: 1, opted_out_at: null };
}

export function setOptOut(db, orgId, lead, { channels = null } = {}) {
  const now = new Date().toISOString();
  const row = lead.id ? db.prepare("SELECT * FROM communication_preferences WHERE organization_id = ? AND lead_id = ?").get(orgId, lead.id) : null;
  const zero = channels ? channels.map((c) => `${c} = 0`).join(", ") : "email = 0, sms = 0, whatsapp = 0, marketing = 0";
  if (row) {
    db.prepare(`UPDATE communication_preferences SET ${zero}, opted_out_at = ?, updated_at = ? WHERE id = ?`).run(now, now, row.id);
  } else {
    db.prepare(
      `INSERT INTO communication_preferences (id, organization_id, customer_id, lead_id, ${channels ? channels.map((c) => `${c}`).join(",") : "email, sms, whatsapp, marketing"}, transactional, opted_out_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${channels ? channels.map(() => "0").join(",") : "0,0,0,0"}, 1, ?, ?, ?)`
    ).run(randomUUID(), orgId, lead.customer_id || null, lead.id || null, now, now, now);
  }
}

/** Motif de désabonnement dans un message client (spec §52).
 *  « STOP » (majuscules, convention SMS) est sensible à la casse — un simple
 *  « stop » dans le texte (ex. un nom propre) ne désabonne pas. */
export function isOptOutMessage(text) {
  const t = String(text || "");
  if (/\bSTOP\b/.test(t)) return true;
  return /\bunsubscribe\b|d[ée]sabonnement|d[ée]sabonnez[- ]?moi|ne plus me (?:re)?(?:conter|contacter)|arr[êe]tez[- ]?les (?:relances|messages)/i.test(t);
}

/* ---------- Planification (spec §18) ---------- */
/**
 * Planifie un follow-up : ajuste sur les business hours (timezone de l'org),
 * met à jour next_followup_at + followup_reason du lead, retourne l'entrée.
 */
export function scheduleFollowUp(db, { org, lead, channel = "WEBCHAT", subject = null, message, reason = null, waitMs = 0, sequence_id = null, step = null, campaign_id = null, scheduledAtIso = null }) {
  const now = new Date();
  const fromMs = scheduledAtIso ? new Date(scheduledAtIso).getTime() : now.getTime() + waitMs;
  // Spec §25 : seule la règle CONFIGURÉE s'applique (dans organizations.settings) ; sans configuration → 24/7
  let orgSettings = {};
  try { orgSettings = org.settings ? JSON.parse(org.settings) : {}; } catch { orgSettings = {}; }
  const bh = (orgSettings.business_hours && typeof orgSettings.business_hours === "object" && Array.isArray(orgSettings.business_hours.days)) ? orgSettings.business_hours : null;
  const timezone = org.timezone || "Africa/Lome";
  const scheduledAt = bh
    ? nextBusinessSlot(fromMs, { timezone, days: bh.days, open: Number(bh.open) >= 0 ? Number(bh.open) : 480, close: Number(bh.close) > 0 ? Number(bh.close) : 1440 })
    : new Date(fromMs).toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO followup_history (id, organization_id, lead_id, sequence_id, campaign_id, step, channel, subject, message, status, scheduled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)`
  ).run(id, org.id, lead.id, sequence_id, campaign_id, step, channel, subject, String(message || "").slice(0, 2000), scheduledAt, now.toISOString());
  if (!sequence_id) { // les séquences gèrent leur propre planning
    db.prepare("UPDATE leads SET next_followup_at = ?, follow_up_message = ?, followup_reason = ?, updated_at = ? WHERE id = ?")
      .run(scheduledAt, String(message || "").slice(0, 500), reason, now.toISOString(), lead.id);
  }
  return db.prepare("SELECT * FROM followup_history WHERE id = ?").get(id);
}

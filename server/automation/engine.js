// server/automation/engine.js — Phase 5 : Automation Engine
// EVENT → CONDITION → RULE EVALUATION → ACTION → LOG → MEASUREMENT
//
// Sécurité (spec §29) : avant chaque action — org, utilisateur, permission,
// opt-out, limites anti-spam, canal, statut du lead, conditions — puis
// exécution + journalisation. Idempotence (spec §30) : une action n'est jamais
// exécutée deux fois (clé idempotency + dédup 24h).

import { randomUUID } from "node:crypto";
import { can } from "../rbac.js";
import { emitEvent, lastLeadResponse, leadRepliedSince, humanTakeoverActive } from "./events.js";
import { sendOnChannel } from "../channels/index.js";
import {
  getLimits, checkCommunicationLimits, getPreferences, scheduleFollowUp,
  parseWait, renderTemplate, templateVars, generateFollowUpMessage, nextBusinessSlot,
} from "./followup.js";
import { logPrediction, resolveOutcome } from "./prediction.js";

const now = () => new Date().toISOString();

/* ---------- Settings d'organisation (followup_mode, business hours, seuils ML) ---------- */
export function orgAutomationSettings(db, org) {
  const settings = org.settings ? JSON.parse(org.settings) : {};
  return {
    followup_mode: ["AUTO", "APPROVAL_REQUIRED", "MANUAL"].includes(settings.followup_mode) ? settings.followup_mode : "AUTO",
    business_hours: settings.business_hours && typeof settings.business_hours === "object" ? settings.business_hours : null,
    ml_min_resolved: Number(settings.ml_min_resolved) || 100,
  };
}

/* ---------- Contexte d'un lead (lead + deal + customer + produit) ---------- */
export function loadLeadContext(db, orgId, leadId) {
  const lead = leadId ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(leadId, orgId) : null;
  if (!lead) return { lead: null, deal: null, customer: null, product: null };
  const deal = db.prepare("SELECT * FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(leadId, orgId) || null;
  const customer = lead.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ? AND organization_id = ?").get(lead.customer_id, orgId) : null;
  let product = null;
  if (deal) {
    product = db.prepare("SELECT p.* FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ? AND p.organization_id = ? ORDER BY dp.total DESC LIMIT 1").get(deal.id, orgId) || null;
  }
  if (!product && String(lead.interest || "").length >= 3) {
    const rows = db.prepare("SELECT * FROM products WHERE organization_id = ? AND status = 'ACTIVE'").all(orgId);
    const interest = String(lead.interest).toLowerCase();
    product = rows.find((p) => interest.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(interest)) || null;
  }
  return { lead, deal, customer, product };
}

/* ---------- Conditions (spec §4) ---------- */
const FIELD_RESOLVERS = {
  "lead.score": (c) => c.lead?.score ?? null,
  "lead.status": (c) => c.lead?.status ?? null,
  "lead.priority": (c) => c.lead?.priority ?? null,
  "lead.intent": (c) => c.lead?.purchase_intent ?? null,
  "lead.source": (c) => c.lead?.source ?? null,
  "lead.budget": (c) => c.lead?.budget ?? null,
  "lead.created_at": (c) => c.lead ? daysSince(c.lead.created_at) : null,
  "lead.hot": (c) => c.lead?.hot ? 1 : 0,
  "lead.at_risk": (c) => c.lead?.at_risk ? 1 : 0,
  "deal.value": (c) => c.deal?.value ?? null,
  "deal.stage": (c) => c.deal?.stage ?? null,
  "customer.country": (c) => c.customer?.country ?? null,
  "customer.city": (c) => c.customer?.city ?? null,
  "last_activity": (c) => c.lead ? daysSince(c.lead.last_contact_at || c.lead.updated_at) : null,
  "last_response": (c) => (c.lead && c.lastResponse) ? daysSince(c.lastResponse) : null,
  "product.category": (c) => c.product?.category_name ?? c.product?.name ?? null,
};

function daysSince(iso) {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 86400e3;
  return Number.isFinite(d) ? Math.floor(d) : null;
}

const NUMERIC_FIELDS = new Set(["lead.score", "lead.budget", "lead.created_at", "deal.value", "last_activity", "last_response", "lead.hot", "lead.at_risk"]);

/** Évalue une condition {field, operator, value} contre le contexte. */
export function evaluateCondition(context, cond) {
  if (!cond || !cond.field || !cond.operator) return true;
  const resolver = FIELD_RESOLVERS[cond.field];
  if (!resolver) return false; // champ inconnu → condition non remplie (prudence)
  const actual = resolver({ ...context, lastResponse: context.lastResponse ?? (context.lead ? lastLeadResponse(context.db, context.lead.organization_id, context.lead.id)?.created_at : null) });
  const expected = cond.value;
  const numeric = NUMERIC_FIELDS.has(cond.field);
  let a = actual, e = expected;
  if (numeric) { a = actual == null ? null : Number(actual); e = Number(expected); }
  else { a = String(actual ?? "").toLowerCase(); e = Array.isArray(expected) ? expected.map((x) => String(x).toLowerCase()) : String(expected ?? "").toLowerCase(); }
  switch (cond.operator) {
    case "=": case "eq": return a != null && (numeric ? a === e : a === e);
    case "!=": case "neq": return a != null && (numeric ? a !== e : a !== e);
    case ">": return a != null && a > e;
    case "<": return a != null && a < e;
    case ">=": case "gte": return a != null && a >= e;
    case "<=": case "lte": return a != null && a <= e;
    case "contains": return a != null && String(a).includes(e);
    case "not_contains": return a != null && !String(a).includes(e);
    case "in": return Array.isArray(e) && a != null && e.includes(a);
    case "not_in": return Array.isArray(e) && (a == null || !e.includes(a));
    default: return false;
  }
}

export function allConditionsPass(context, conditions) {
  return (conditions || []).every((c) => evaluateCondition(context, c));
}

/* ---------- Notifications internes (spec §23) avec dédup 24h ---------- */
export function notifyUser(db, { orgId, userId, type, title, message = null, link = null, leadId = null }) {
  if (!userId) return null;
  const dedup = db.prepare(
    "SELECT 1 n FROM notifications WHERE organization_id = ? AND user_id = ? AND type = ? AND COALESCE(lead_id, '') = COALESCE(?, '') AND created_at > datetime('now', '-1 day') LIMIT 1"
  ).get(orgId, userId, type, leadId || null);
  if (dedup) return null;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO notifications (id, organization_id, user_id, type, title, message, link, lead_id, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
  ).run(id, orgId, userId, type, String(title).slice(0, 120), message ? String(message).slice(0, 500) : null, link, leadId, now());
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
}

/** Membres notifiables d'une org (sauf VIEWER). */
export function notifiableMembers(db, orgId, excludeUserId = null) {
  return db.prepare(
    `SELECT om.user_id, u.first_name, u.last_name FROM organization_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = ? AND om.status = 'active' AND om.role != 'VIEWER' AND om.user_id != ?
     ORDER BY om.created_at ASC`
  ).all(orgId, excludeUserId || "none");
}

/* ---------- Assignation intelligente (spec §21-22) ---------- */
/**
 * Assigne un lead selon les règles actives : ROUND_ROBIN / WORKLOAD
 * (les autres stratégies sont stockées mais retombent sur round robin).
 * Renvoie l'assigné (null si aucune règle ou aucun membre disponible).
 */
export function smartAssign(db, orgId, leadId) {
  const rule = db.prepare(
    "SELECT * FROM assignment_rules WHERE organization_id = ? AND active = 1 ORDER BY created_at ASC LIMIT 1"
  ).get(orgId);
  if (!rule) return null;
  let team;
  try { team = JSON.parse(rule.team_member_ids || "[]"); } catch { team = []; }
  team = team.filter((id) => typeof id === "string" && id.length === 36);
  if (!team.length) return null;
  let chosen;
  if (rule.strategy === "WORKLOAD") {
    const loads = team.map((uid) => ({ uid, n: db.prepare("SELECT COUNT(*) n FROM leads WHERE organization_id = ? AND assigned_to = ? AND status NOT IN ('WON','LOST')").get(orgId, uid).n }));
    loads.sort((a, b) => a.n - b.n);
    chosen = loads[0].uid;
  } else { // ROUND_ROBIN : le moins servi récemment
    const counts = team.map((uid) => ({ uid, n: db.prepare("SELECT COUNT(*) n FROM leads WHERE organization_id = ? AND assigned_to = ?").get(orgId, uid).n }));
    counts.sort((a, b) => a.n - b.n);
    chosen = counts[0].uid;
  }
  db.prepare("UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ? AND organization_id = ?").run(chosen, now(), leadId, orgId);
  const user = db.prepare("SELECT first_name, last_name FROM users WHERE id = ?").get(chosen);
  return { user_id: chosen, name: user ? `${user.first_name} ${user.last_name}` : null, strategy: rule.strategy };
}

/* ---------- Exécution d'une action (spec §29, idempotence §30) ---------- */
const ACTION_PERMISSIONS = {
  CREATE_TASK: "crm:write", UPDATE_LEAD: "crm:write", UPDATE_SCORE: "crm:write",
  ADD_NOTE: "crm:write", CREATE_ACTIVITY: "crm:write", SEND_EMAIL: "crm:write",
  SEND_MESSAGE: "crm:write", CREATE_DEAL: "crm:write", HANDOFF_HUMAN: "crm:write",
  ASSIGN_LEAD: "assign:leads", NOTIFY_SALES_AGENT: null, START_SEQUENCE: "automation:manage", STOP_SEQUENCE: "automation:manage",
};
const SEND_ACTIONS = new Set(["SEND_EMAIL", "SEND_MESSAGE"]);
const COMMERCIAL_ACTIONS = new Set(["SEND_EMAIL", "SEND_MESSAGE", "CREATE_DEAL", "START_SEQUENCE", "HANDOFF_HUMAN"]);

function resolveActorUser(db, orgId, automation) {
  if (automation?.created_by) {
    const m = db.prepare("SELECT u.id, u.first_name, u.last_name, om.role FROM users u JOIN organization_members om ON om.user_id = u.id WHERE u.id = ? AND om.organization_id = ? AND om.status = 'active'").get(automation.created_by, orgId);
    if (m) return m;
  }
  return db.prepare(
    `SELECT u.id, u.first_name, u.last_name, om.role FROM users u JOIN organization_members om ON om.user_id = u.id
     WHERE om.organization_id = ? AND om.role = 'OWNER' AND om.status = 'active' LIMIT 1`
  ).get(orgId) || null;
}

function logAutomation(db, { orgId, automationId, eventId, trigger, conditions, action, status, error = null, idempotencyKey = null, executionTime = 0 }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO automation_logs (id, organization_id, automation_id, event_id, trigger, conditions, action, status, error, idempotency_key, execution_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, automationId, eventId, trigger, conditions ? JSON.stringify(conditions) : null, action, status, error, idempotencyKey, executionTime, now());
  return id;
}

function alreadyExecuted(db, orgId, idempotencyKey) {
  return !!db.prepare("SELECT 1 n FROM automation_logs WHERE organization_id = ? AND idempotency_key = ?").get(orgId, idempotencyKey);
}

/** Dédup 24h : même automation + même lead + même action (anti-spam, spec §51). */
function recentExecution(db, orgId, automationId, leadId, action) {
  if (!leadId) return false;
  return !!db.prepare(
    "SELECT 1 n FROM automation_logs WHERE organization_id = ? AND automation_id = ? AND action = ? AND status = 'SUCCESS' AND idempotency_key LIKE ? AND created_at > datetime('now', '-1 day') LIMIT 1"
  ).get(orgId, automationId, action, `${automationId}:${leadId}%`);
}

/**
 * Exécute UNE action avec la checklist de sécurité complète.
 * Renvoie { status: SUCCESS|FAILED|SKIPPED|CANCELLED, error? }.
 */
export async function executeAction(db, { orgId, actor, automation, event, action, actionIndex, context, idempotencyKey }) {
  const t0 = Date.now();
  const actionType = String(action?.action || "").toUpperCase();
  const lead = context.lead;
  const base = { orgId, automationId: automation?.id || null, eventId: event?.id || null, trigger: event?.type || "MANUAL", action: actionType };

  if (!ACTION_PERMISSIONS.hasOwnProperty(actionType)) {
    return log(db, { ...base, status: "FAILED", error: `Action inconnue : ${actionType}`, executionTime: Date.now() - t0 });
  }
  // 1-2. Organisation + utilisateur (acteur = créateur de l'automation ou OWNER)
  const actorUser = actor || resolveActorUser(db, orgId, automation);
  if (!actorUser) return log(db, { ...base, status: "FAILED", error: "Aucun acteur valide pour exécuter l'action.", executionTime: Date.now() - t0 });
  // 3. Permission
  const perm = ACTION_PERMISSIONS[actionType];
  if (perm && !can(actorUser.role, perm)) {
    return log(db, { ...base, status: "FAILED", error: `Permission insuffisante (${perm}) pour l'acteur.`, executionTime: Date.now() - t0 });
  }
  // 30. Idempotence (clé stricte)
  if (idempotencyKey && alreadyExecuted(db, orgId, idempotencyKey)) {
    return log(db, { ...base, status: "SKIPPED", error: "Idempotence : action déjà exécutée pour cet événement.", idempotencyKey, executionTime: Date.now() - t0 });
  }
  // Anti-spam : même automation + lead + action dans les dernières 24h (hors envois gérés par les limites)
  if (lead && !SEND_ACTIONS.has(actionType) && recentExecution(db, orgId, automation?.id, lead.id, actionType)) {
    return log(db, { ...base, status: "SKIPPED", error: "Dédup 24h : action déjà exécutée pour ce lead.", idempotencyKey, executionTime: Date.now() - t0 });
  }
  // 7. Statut du lead (actions commerciales)
  if (COMMERCIAL_ACTIONS.has(actionType) && lead) {
    if (["WON", "LOST"].includes(lead.status)) return log(db, { ...base, status: "CANCELLED", error: `Lead ${lead.status} : action commerciale annulée.`, executionTime: Date.now() - t0 });
    if (context.deal && ["WON", "LOST"].includes(context.deal.stage)) return log(db, { ...base, status: "CANCELLED", error: `Deal ${context.deal.stage} : action commerciale annulée.`, executionTime: Date.now() - t0 });
  }
  // 8. Garde de ré-exécution (action différée)
  if (action.guard?.no_user_response && event?.lead_id && event.created_at) {
    if (leadRepliedSince(db, orgId, event.lead_id, event.created_at)) {
      return log(db, { ...base, status: "CANCELLED", error: "Garde : le prospect a répondu depuis l'événement.", executionTime: Date.now() - t0 });
    }
  }

  let result;
  try {
    result = await runAction(db, { orgId, actor: actorUser, action, context, event, automation });
  } catch (e) {
    result = { status: "failed", error: String(e.message || e).slice(0, 300) };
  }
  const status = result.status === "sent" ? "SUCCESS" : result.status === "skipped" ? "SKIPPED" : result.status === "cancelled" ? "CANCELLED" : result.status === "failed" ? "FAILED" : "SUCCESS";
  log(db, { ...base, status, error: result.error || null, idempotencyKey, executionTime: Date.now() - t0 });
  return { status, error: result.error || null };
}

function log(db, entry) {
  logAutomation(db, entry);
  return { status: entry.status, error: entry.error || null };
}

async function runAction(db, { orgId, actor, action, context, event, automation }) {
  const lead = context.lead;
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  switch (String(action.action).toUpperCase()) {
    case "CREATE_TASK": {
      const dueDays = Number(action.due_days ?? 1);
      const due = new Date(Date.now() + dueDays * 86400e3).toISOString().slice(0, 10);
      db.prepare(
        `INSERT INTO tasks (id, organization_id, assigned_to, lead_id, deal_id, title, description, priority, status, due_date, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'TODO', ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, lead?.assigned_to || actor.id, lead?.id || null, context.deal?.id || null,
        String(action.title || (lead ? `Suivi : ${lead.name}` : "Suivi")).slice(0, 120),
        (action.description || `Créé par l'automation « ${automation?.name || "?"} ».`).slice(0, 500),
        ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(action.priority) ? action.priority : "MEDIUM",
        due, actor.id, now(), now());
      return { status: "success" };
    }
    case "UPDATE_LEAD": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      const sets = [], args = [];
      if (action.status && ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON", "LOST"].includes(action.status.toUpperCase())) { sets.push("status = ?"); args.push(action.status.toUpperCase()); }
      if (action.notes) { sets.push("notes = ?"); args.push(String(action.notes).slice(0, 500)); }
      if (!sets.length) return { status: "skipped", error: "UPDATE_LEAD sans champ valide." };
      sets.push("updated_at = ?"); args.push(now(), lead.id, orgId);
      db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...args);
      return { status: "success" };
    }
    case "UPDATE_SCORE": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      const base = lead.score ?? 0;
      const target = action.score != null ? Number(action.score) : base + Number(action.delta ?? 0);
      const score = Math.max(0, Math.min(100, Math.round(target)));
      db.prepare("UPDATE leads SET score = ?, updated_at = ? WHERE id = ? AND organization_id = ?").run(score, now(), lead.id, orgId);
      return { status: "success" };
    }
    case "ADD_NOTE": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      db.prepare("INSERT INTO notes (id, organization_id, user_id, lead_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, actor.id, lead.id, String(action.content || "Note automatique.").slice(0, 2000), now(), now());
      return { status: "success" };
    }
    case "CREATE_ACTIVITY": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      db.prepare("INSERT INTO activities (id, organization_id, lead_id, user_id, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, lead.id, actor.id, ["NOTE", "STATUS_CHANGE", "PURCHASE", "FOLLOW_UP"].includes(action.type) ? action.type : "NOTE",
          String(action.description || `Activité (automation « ${automation?.name || "?"} »).`).slice(0, 500), now());
      return { status: "success" };
    }
    case "SEND_EMAIL": case "SEND_MESSAGE": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      const channel = action.action === "SEND_EMAIL" ? "EMAIL" : (action.channel || "WEBCHAT").toUpperCase();
      // 4. Opt-out (spec §12)
      const prefs = getPreferences(db, orgId, lead);
      const channelKey = { EMAIL: "email", SMS: "sms", WHATSAPP: "whatsapp" }[channel];
      if (prefs.marketing === 0) return { status: "skipped", error: "Opt-out marketing : envoi refusé." };
      if (channelKey && prefs[channelKey] === 0) return { status: "skipped", error: `Opt-out canal ${channel} : envoi refusé.` };
      // 5. Limites anti-spam (spec §11)
      const limits = checkCommunicationLimits(db, orgId, lead.id);
      if (!limits.ok) return { status: "skipped", error: limits.reason };
      // 6. Canal (spec §13, Phase 6 §13-14) — envoi RÉEL via l'API officielle,
      // jamais d'envoi simulé ; « Canal non configuré. » si non connecté
      // Contenu : template ou message inline (variables échappées)
      const agentName = `${actor.first_name} ${actor.last_name}`;
      const vars = templateVars(db, orgId, lead, { product: context.product, deal: context.deal, salesAgentName: agentName });
      const rendered = renderTemplate(db, orgId, { template_id: action.template_id || null, subject: action.subject || null, content: action.content || null }, vars);
      const content = rendered.content || generateFollowUpMessage({ lead, product: context.product, deal: context.deal, objection: (action.objection_type && { type: action.objection_type }) || null, agentName, currency: lead.currency || org.currency });
      // 9. Exécution : follow-up d'abord (pour lier le receipt), puis envoi réel
      const fid = randomUUID();
      db.prepare(
        `INSERT INTO followup_history (id, organization_id, lead_id, step, channel, subject, message, status, attempts, scheduled_at, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'SCHEDULED', 1, ?, ?)`
      ).run(fid, orgId, lead.id, channel, rendered.subject, content, now(), now());
      const sent = await sendOnChannel(db, { orgId, channel, lead, subject: rendered.subject, text: content, followup_id: fid });
      if (sent.status === "sent") {
        db.prepare("UPDATE followup_history SET status = 'SENT', sent_at = ? WHERE id = ?").run(now(), fid);
        emitEvent(db, orgId, { type: "FOLLOWUP_SENT", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { channel, followup_id: fid } });
        return { status: "success" };
      }
      db.prepare("UPDATE followup_history SET status = 'FAILED', error = ? WHERE id = ?").run(sent.error || null, fid);
      emitEvent(db, orgId, { type: "FOLLOWUP_FAILED", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { channel, followup_id: fid, error: sent.error || null } });
      return { status: "failed", error: sent.error };
    }
    case "ASSIGN_LEAD": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      const target = action.user_id || (smartAssign(db, orgId, lead.id) || {}).user_id;
      if (!target) return { status: "failed", error: "Aucun destinataire pour l'assignation (règle vide ?)." };
      db.prepare("UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ? AND organization_id = ?").run(target, now(), lead.id, orgId);
      return { status: "success" };
    }
    case "CREATE_DEAL": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      // Jamais de valeur inventée (spec) : valeur explicite ou valeur estimée connue
      const value = action.value != null ? Number(action.value) : lead.estimated_value;
      if (value == null || !Number.isFinite(value) || value <= 0) return { status: "failed", error: "Aucune valeur estimée disponible — deal non créé (jamais de valeur inventée)." };
      const existing = db.prepare("SELECT id FROM deals WHERE lead_id = ? AND organization_id = ? LIMIT 1").get(lead.id, orgId);
      if (existing) return { status: "skipped", error: "Un deal existe déjà pour ce lead (idempotence)." };
      const prob = Math.min(Math.max(lead.conversion_probability || 50, 40), 90);
      db.prepare(
        `INSERT INTO deals (id, organization_id, customer_id, lead_id, name, value, currency, stage, probability, assigned_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'QUALIFICATION', ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, lead.customer_id, lead.id, String(action.name || `Commande ${lead.name}`).slice(0, 120),
        value, lead.currency || org.currency, prob, lead.assigned_to, now(), now());
      return { status: "success" };
    }
    case "NOTIFY_SALES_AGENT": {
      let targets = action.user_id ? [action.user_id] : (lead ? [lead.assigned_to].filter(Boolean) : []);
      if (!targets.length) targets = notifiableMembers(db, orgId).map((m) => m.user_id);
      let n = 0;
      for (const uid of targets) {
        notifyUser(db, { orgId, userId: uid, type: action.notification_type || "AUTOMATION", title: String(action.title || `Automation : ${automation?.name || "action"}`).slice(0, 120), message: action.message, link: action.link || (lead ? `/dashboard/leads/${lead.id}` : null), leadId: lead?.id || null });
        n++;
      }
      return n ? { status: "success" } : { status: "skipped", error: "Aucun destinataire à notifier." };
    }
    case "HANDOFF_HUMAN": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      const conv = lead.conversation_id ? db.prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ?").get(lead.conversation_id, orgId) : db.prepare("SELECT * FROM conversations WHERE lead_id = ? AND organization_id = ? ORDER BY updated_at DESC LIMIT 1").get(lead.id, orgId);
      if (conv) db.prepare("UPDATE conversations SET status = 'HANDOFF', updated_at = ? WHERE id = ?").run(now(), conv.id);
      db.prepare(
        `INSERT INTO tasks (id, organization_id, assigned_to, lead_id, title, description, priority, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'HIGH', 'TODO', ?, ?, ?)`
      ).run(randomUUID(), orgId, lead.assigned_to || actor.id, lead.id, `Relais humain : ${lead.name}`, String(action.reason || "Handoff déclenché par automation.").slice(0, 500), actor.id, now(), now());
      for (const m of notifiableMembers(db, orgId)) notifyUser(db, { orgId, userId: m.user_id, type: "HUMAN_HANDOFF", title: `Handoff humain : ${lead.name}`, message: action.reason, link: `/dashboard/leads/${lead.id}`, leadId: lead.id });
      return { status: "success" };
    }
    case "START_SEQUENCE": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      const seq = action.sequence_id ? db.prepare("SELECT * FROM sequences WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'").get(action.sequence_id, orgId) : null;
      if (!seq) return { status: "failed", error: "Séquence introuvable ou inactive." };
      enrollLeadInSequence(db, orgId, seq, lead.id);
      return { status: "success" };
    }
    case "STOP_SEQUENCE": {
      if (!lead) return { status: "skipped", error: "Aucun lead dans le contexte." };
      cancelFollowUpsForLead(db, orgId, lead.id, "Séquence arrêtée par automation");
      return { status: "success" };
    }
    default:
      return { status: "failed", error: "Action non implémentée." };
  }
}

/* ---------- Séquences (spec §9-10) ---------- */
export function enrollLeadInSequence(db, orgId, seq, leadId) {
  const existing = db.prepare("SELECT id FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ? AND lead_id = ? AND status = 'ACTIVE'").get(orgId, seq.id, leadId);
  if (existing) return existing;
  let steps = [];
  try { steps = JSON.parse(seq.steps || "[]"); } catch { steps = []; }
  const id = randomUUID();
  const nowIso = now();
  // 1ʳʳ étape immédiate (next_run_at = maintenant) ; les waits sont appliqués au tick
  db.prepare(
    `INSERT INTO sequence_enrollments (id, organization_id, sequence_id, lead_id, status, current_step, next_run_at, enrolled_at, updated_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?)`
  ).run(id, orgId, seq.id, leadId, nowIso, nowIso, nowIso);
  emitEvent(db, orgId, { type: "SEQUENCE_STARTED", entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { sequence_id: seq.id, sequence_name: seq.name } });
  return db.prepare("SELECT * FROM sequence_enrollments WHERE id = ?").get(id);
}

/** Arrêt immédiat : séquences actives + follow-ups en attente du lead. */
export function cancelFollowUpsForLead(db, orgId, leadId, reason) {
  const nowIso = now();
  const enroll = db.prepare("SELECT * FROM sequence_enrollments WHERE organization_id = ? AND lead_id = ? AND status = 'ACTIVE'").all(orgId, leadId);
  for (const e of enroll) {
    db.prepare("UPDATE sequence_enrollments SET status = 'STOPPED', stop_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowIso, e.id);
    emitEvent(db, orgId, { type: "SEQUENCE_STOPPED", entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { sequence_id: e.sequence_id, reason } });
  }
  const pend = db.prepare("SELECT id FROM followup_history WHERE organization_id = ? AND lead_id = ? AND status IN ('SCHEDULED', 'PENDING_APPROVAL')").all(orgId, leadId);
  for (const f of pend) {
    db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?").run(reason, f.id);
  }
  if (pend.length) emitEvent(db, orgId, { type: "FOLLOWUP_CANCELLED", entity_type: "lead", entity_id: leadId, lead_id: leadId, payload: { reason, count: pend.length } });
  db.prepare("UPDATE leads SET next_followup_at = NULL, follow_up_message = NULL, at_risk = CASE WHEN ? THEN 0 ELSE at_risk END, updated_at = ? WHERE id = ? AND organization_id = ?").run(reason === "réponse du prospect" ? 1 : 0, nowIso, leadId, orgId);
}

/* ---------- Traitement d'un événement (CONDITION → ACTION → LOG) ---------- */
export async function processEvent(db, event, { actor = null } = {}) {
  const automations = db.prepare("SELECT * FROM automations WHERE organization_id = ? AND status = 'ACTIVE' AND trigger = ?").all(event.organization_id, event.type);
  const results = [];
  for (const automation of automations) {
    const context = event.lead_id
      ? { ...loadLeadContext(db, event.organization_id, event.lead_id), db }
      : { lead: null, deal: null, customer: null, product: null, db };
    if (automation.trigger.startsWith("LEAD_") || automation.trigger.startsWith("DEAL_") || automation.trigger.startsWith("PURCHASE_") || automation.trigger.startsWith("NO_RESPONSE") || automation.trigger.startsWith("OPT_OUT")) {
      if (!context.lead && automation.trigger !== "TASK_OVERDUE") {
        logAutomation(db, { orgId: event.organization_id, automationId: automation.id, eventId: event.id, trigger: event.type, action: null, status: "SKIPPED", error: "Aucun lead dans le contexte de l'événement." });
        continue;
      }
    }
    let conditions = [];
    try { conditions = JSON.parse(automation.conditions || "[]"); } catch { conditions = []; }
    if (!allConditionsPass(context, conditions)) {
      logAutomation(db, { orgId: event.organization_id, automationId: automation.id, eventId: event.id, trigger: event.type, conditions, action: null, status: "SKIPPED", error: "Conditions non remplies." });
      continue;
    }
    let actions = [];
    try { actions = JSON.parse(automation.actions || "[]"); } catch { actions = []; }
    for (const [i, action] of actions.entries()) {
      if (action.delay_minutes && Number(action.delay_minutes) > 0) {
        // Action différée : exécutée au prochain tick APRÈS re-vérification de la garde
        const id = randomUUID();
        const due = new Date(Date.now() + Number(action.delay_minutes) * 60e3).toISOString();
        db.prepare(
          "INSERT INTO automation_runs (id, organization_id, automation_id, event_id, lead_id, action, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)"
        ).run(id, event.organization_id, automation.id, event.id, event.lead_id || null, JSON.stringify({ ...action, delay_minutes: 0 }), due, now());
        results.push({ action: action.action, status: "SCHEDULED", delay_minutes: Number(action.delay_minutes) });
        continue;
      }
      const key = `${automation.id}:${event.lead_id || "-"}:${event.id}:${i}`;
      const r = await executeAction(db, { orgId: event.organization_id, actor, automation, event, action, actionIndex: i, context, idempotencyKey: key });
      results.push({ action: action.action, status: r.status, error: r.error });
    }
  }
  return results;
}

/* ---------- Tick du planificateur (suivi, séquences, runs différés, tâches) ---------- */
export async function tick(db) {
  const nowIso = now();
  const stats = { followups: 0, sent: 0, failed: 0, cancelled: 0, approvals: 0, sequences: 0, runs: 0, overdue_tasks: 0 };

  // 1. Follow-ups échus
  const due = db.prepare("SELECT * FROM followup_history WHERE status = 'SCHEDULED' AND scheduled_at <= ?").all(nowIso);
  if (process.env.DEBUG_TICK) { try { const all = db.prepare("SELECT id, status, scheduled_at, attempts FROM followup_history").all(); const fs = await import("node:fs"); fs.appendFileSync("/tmp/tickdbg.log", "TICKSTART nowIso:" + nowIso + " due:" + due.length + "\n"); } catch {} }
  for (const f of due) {
    if (process.env.DEBUG_TICK) try { (await import("node:fs")).appendFileSync("/tmp/tickdbg.log", "  due-item " + f.id + " " + f.channel + " sched:" + f.scheduled_at + "\n"); } catch {}
    stats.followups++;
    const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(f.lead_id, f.organization_id);
    if (!lead) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'Lead supprimé' WHERE id = ?").run(f.id); stats.cancelled++; continue; }
    const deal = db.prepare("SELECT * FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(f.lead_id, f.organization_id) || null;
    // Stop conditions (spec §10)
    if (["WON", "LOST"].includes(lead.status)) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?").run(`Lead ${lead.status}`, f.id); stats.cancelled++; continue; }
    if (deal && ["WON", "LOST"].includes(deal.stage)) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'Deal clos' WHERE id = ?").run(f.id); stats.cancelled++; continue; }
    if (leadRepliedSince(db, f.organization_id, f.lead_id, f.scheduled_at)) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'réponse du prospect' WHERE id = ?").run(f.id); stats.cancelled++; continue; }
    if (humanTakeoverActive(db, f.organization_id, f.lead_id)) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'prise en main humaine' WHERE id = ?").run(f.id); stats.cancelled++; continue; }
    const prefs = getPreferences(db, f.organization_id, lead);
    if (prefs.marketing === 0 || ({ EMAIL: "email", SMS: "sms", WHATSAPP: "whatsapp" }[f.channel] && prefs[{ EMAIL: "email", SMS: "sms", WHATSAPP: "whatsapp" }[f.channel]] === 0)) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'opt-out' WHERE id = ?").run(f.id); stats.cancelled++; continue; }
    const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(f.organization_id);
    const { followup_mode } = orgAutomationSettings(db, org);
    if (followup_mode === "MANUAL") { db.prepare("UPDATE followup_history SET status = 'DRAFTED' WHERE id = ?").run(f.id); continue; }
    if (followup_mode === "APPROVAL_REQUIRED") {
      db.prepare("UPDATE followup_history SET status = 'PENDING_APPROVAL' WHERE id = ?").run(f.id);
      stats.approvals++;
      let targets = [lead.assigned_to].filter(Boolean);
      if (!targets.length) targets = notifiableMembers(db, f.organization_id).map((m) => m.user_id);
      for (const uid of targets) notifyUser(db, { orgId: f.organization_id, userId: uid, type: "FOLLOWUP_APPROVAL", title: `Validation follow-up : ${lead.name}`, message: f.message.slice(0, 200), link: `/dashboard/followups`, leadId: f.lead_id });
      continue;
    }
    // AUTO : envoi réel via le canal officiel (Phase 6) — jamais simulé.
    // Robustesse : un échec isolé ne doit pas casser le tick (jamais de boucle infinie).
    try {
      const limits = checkCommunicationLimits(db, f.organization_id, f.lead_id);
      if (!limits.ok) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?").run(limits.reason, f.id); stats.cancelled++; continue; }
      const sent = await sendOnChannel(db, { orgId: f.organization_id, channel: f.channel, lead, subject: f.subject, text: f.message, followup_id: f.id });
      if (sent.status === "sent") {
        db.prepare("UPDATE followup_history SET status = 'SENT', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(nowIso, f.id);
        stats.sent++;
        emitEvent(db, f.organization_id, { type: "FOLLOWUP_SENT", entity_type: "lead", entity_id: f.lead_id, lead_id: f.lead_id, payload: { followup_id: f.id, channel: f.channel } });
        continue;
      }
      // Échec déterminé (canal non configuré, adresse manquante) → FAILED direct ;
      // échec transitoire → retry limité (max 3 tentatives, jamais de boucle infinie)
      const deterministic = /non configuré|manquante|invalide/i.test(sent.error || "");
      const attempts = deterministic ? 3 : f.attempts + 1;
      const failed = attempts >= 3;
      db.prepare("UPDATE followup_history SET status = ?, attempts = ?, error = ? WHERE id = ?").run(failed ? "FAILED" : "SCHEDULED", attempts, sent.error || null, f.id);
      if (!failed) db.prepare("UPDATE followup_history SET scheduled_at = ? WHERE id = ?").run(new Date(Date.now() + 5 * 60e3).toISOString(), f.id);
      stats.failed++;
      if (failed) {
        emitEvent(db, f.organization_id, { type: "FOLLOWUP_FAILED", entity_type: "lead", entity_id: f.lead_id, lead_id: f.lead_id, payload: { followup_id: f.id, channel: f.channel, error: sent.error } });
        for (const uid of notifiableMembers(db, f.organization_id).map((m) => m.user_id)) notifyUser(db, { orgId: f.organization_id, userId: uid, type: "AUTOMATION_FAILED", title: `Échec d'envoi : ${lead.name}`, message: sent.error, link: `/dashboard/followups`, leadId: f.lead_id });
      }
    } catch (e) {
      // Un follow-up en échec ne doit pas bloquer les suivants.
      try { db.prepare("UPDATE followup_history SET status = 'FAILED', attempts = attempts + 1, error = ? WHERE id = ?").run(String(e && e.message ? e.message : String(e)).slice(0, 300), f.id); } catch {}
      stats.failed++;
      if (process.env.DEBUG_TICK) try { (await import("node:fs")).appendFileSync("/tmp/tickdbg.log", "  FOLLOWUP-ERROR " + f.id + " " + (e && e.message) + "\n"); } catch {}
    }
  }
  if (process.env.DEBUG_TICK) { try { const fs = await import("node:fs"); const fin = db.prepare("SELECT id, status, attempts, cancel_reason, error FROM followup_history WHERE scheduled_at > '2026-08-26T07:00:00'").all(); fs.appendFileSync("/tmp/tickdbg.log", "TICKEND " + JSON.stringify(fin) + "\n\n"); } catch {} }
  // 2. Séquences : étapes échues
  const enrollments = db.prepare("SELECT * FROM sequence_enrollments WHERE status = 'ACTIVE' AND next_run_at <= ?").all(nowIso);
  for (const e of enrollments) {
    stats.sequences++;
    const seq = db.prepare("SELECT * FROM sequences WHERE id = ? AND organization_id = ?").get(e.sequence_id, e.organization_id);
    const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(e.lead_id, e.organization_id);
    if (!seq || seq.status !== "ACTIVE" || !lead) {
      db.prepare("UPDATE sequence_enrollments SET status = 'STOPPED', stop_reason = ?, updated_at = ? WHERE id = ?").run(seq ? "Séquence désactivée" : "Lead supprimé", nowIso, e.id);
      continue;
    }
    const deal = db.prepare("SELECT * FROM deals WHERE lead_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").get(lead.id, e.organization_id) || null;
    const stopReason = ["WON", "LOST"].includes(lead.status) ? `Lead ${lead.status}`
      : deal && ["WON", "LOST"].includes(deal.stage) ? "Deal clos"
      : leadRepliedSince(db, e.organization_id, lead.id, e.updated_at) ? "réponse du prospect"
      : humanTakeoverActive(db, e.organization_id, lead.id) ? "prise en main humaine"
      : getPreferences(db, e.organization_id, lead).marketing === 0 ? "opt-out" : null;
    if (stopReason) {
      db.prepare("UPDATE sequence_enrollments SET status = 'STOPPED', stop_reason = ?, updated_at = ? WHERE id = ?").run(stopReason, nowIso, e.id);
      cancelFollowUpsForLead(db, e.organization_id, lead.id, stopReason);
      continue;
    }
    let steps = [];
    try { steps = JSON.parse(seq.steps || "[]"); } catch { steps = []; }
    if (e.current_step >= steps.length) {
      db.prepare("UPDATE sequence_enrollments SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(nowIso, e.id);
      emitEvent(db, e.organization_id, { type: "SEQUENCE_COMPLETED", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { sequence_id: seq.id } });
      continue;
    }
    const step = steps[e.current_step];
    const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(e.organization_id);
    const { followup_mode } = orgAutomationSettings(db, org);
    const context = loadLeadContext(db, e.organization_id, lead.id);
    const vars = templateVars(db, e.organization_id, lead, { product: context.product, deal: context.deal, salesAgentName: "" });
    const rendered = renderTemplate(db, e.organization_id, { template_id: step.template_id || null, subject: step.subject || null, content: step.content || null }, vars);
    const content = rendered.content || generateFollowUpMessage({ lead, product: context.product, deal: context.deal, agentName: null, currency: lead.currency || org.currency });
    let entryStatus = "SCHEDULED", entryScheduled = nowIso;
    if (followup_mode === "AUTO") {
      const limits = checkCommunicationLimits(db, e.organization_id, lead.id);
      if (!limits.ok) {
        db.prepare("UPDATE sequence_enrollments SET status = 'STOPPED', stop_reason = ?, updated_at = ? WHERE id = ?").run(limits.reason, nowIso, e.id);
        db.prepare("INSERT INTO followup_history (id, organization_id, lead_id, sequence_id, step, channel, subject, message, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?, ?)")
          .run(randomUUID(), e.organization_id, lead.id, e.sequence_id, e.current_step + 1, seq.channel, rendered.subject, content, limits.reason, nowIso);
        continue;
      }
      const sent = await sendOnChannel(db, { orgId: e.organization_id, channel: seq.channel, lead, subject: rendered.subject, text: content, followup_id: null });
      entryStatus = sent.status === "sent" ? "SENT" : "FAILED";
      if (sent.status === "sent") {
        db.prepare("UPDATE sequence_enrollments SET updated_at = ? WHERE id = ?").run(nowIso, e.id);
        emitEvent(db, e.organization_id, { type: "FOLLOWUP_SENT", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { sequence_id: e.sequence_id, step: e.current_step + 1 } });
      } else {
        db.prepare("UPDATE sequence_enrollments SET status = 'STOPPED', stop_reason = ?, updated_at = ? WHERE id = ?").run(sent.error || "échec d'envoi", nowIso, e.id);
      }
    } else if (followup_mode === "APPROVAL_REQUIRED") {
      entryStatus = "PENDING_APPROVAL";
      entryScheduled = new Date(Date.now() + 86400e3).toISOString();
    } else {
      entryStatus = "DRAFTED";
    }
    db.prepare(
      `INSERT INTO followup_history (id, organization_id, lead_id, sequence_id, step, channel, subject, message, status, scheduled_at, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), e.organization_id, lead.id, e.sequence_id, e.current_step + 1, seq.channel, rendered.subject, content, entryStatus, entryScheduled, entryStatus === "SENT" ? nowIso : null, nowIso);
    // Avancer
    const next = e.current_step + 1;
    if (next >= steps.length) {
      db.prepare("UPDATE sequence_enrollments SET status = 'COMPLETED', current_step = ?, updated_at = ? WHERE id = ?").run(next, nowIso, e.id);
      emitEvent(db, e.organization_id, { type: "SEQUENCE_COMPLETED", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { sequence_id: seq.id } });
    } else {
      const waitMs = parseWait(steps[next].wait || "1d") ?? 86400e3;
      const biz = orgAutomationSettings(db, org).business_hours;
      const nextRun = (biz && Array.isArray(biz.days))
        ? nextBusinessSlot(Date.now() + waitMs, { timezone: org.timezone || "UTC", days: biz.days, open: Number(biz.open) >= 0 ? Number(biz.open) : 480, close: Number(biz.close) > 0 ? Number(biz.close) : 1440 })
        : new Date(Date.now() + waitMs).toISOString();
      db.prepare("UPDATE sequence_enrollments SET current_step = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(next, nextRun, nowIso, e.id);
    }
  }

  // 3. Runs différés (attendre N min → re-vérifier → agir)
  const runs = db.prepare("SELECT * FROM automation_runs WHERE status = 'PENDING' AND due_at <= ?").all(nowIso);
  for (const run of runs) {
    stats.runs++;
    const action = safeParse(run.action);
    const lead = run.lead_id ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(run.lead_id, run.organization_id) : null;
    let cancelReason = null;
    if (run.lead_id && !lead) cancelReason = "Lead supprimé";
    else if (lead && ["WON", "LOST"].includes(lead.status)) cancelReason = `Lead ${lead.status}`;
    else if (run.event_id && action.guard?.no_user_response) {
      const ev = db.prepare("SELECT created_at FROM sales_events WHERE id = ?").get(run.event_id);
      if (ev && leadRepliedSince(db, run.organization_id, run.lead_id, ev.created_at)) cancelReason = "Le prospect a répondu en attendant.";
    }
    if (cancelReason) {
      db.prepare("UPDATE automation_runs SET status = 'CANCELLED' WHERE id = ?").run(run.id);
      logAutomation(db, { orgId: run.organization_id, automationId: run.automation_id, eventId: run.event_id, trigger: "DELAYED", conditions: null, action: action?.action || null, status: "CANCELLED", error: cancelReason });
      continue;
    }
    const event = run.event_id ? db.prepare("SELECT * FROM sales_events WHERE id = ?").get(run.event_id) : null;
    const context = run.lead_id ? { ...loadLeadContext(db, run.organization_id, run.lead_id), db } : { lead: null, deal: null, customer: null, product: null, db };
    const automation = run.automation_id ? db.prepare("SELECT * FROM automations WHERE id = ?").get(run.automation_id) : null;
    const key = `${run.automation_id || "-"}:${run.lead_id || "-"}:${run.id}`;
    const r = await executeAction(db, { orgId: run.organization_id, actor: null, automation, event: event || { id: run.event_id, type: "DELAYED", created_at: run.created_at }, action, context, idempotencyKey: key });
    db.prepare("UPDATE automation_runs SET status = ? WHERE id = ?").run(r.status === "SUCCESS" ? "DONE" : r.status === "SKIPPED" ? "DONE" : "CANCELLED", run.id);
  }

  // 4. Tâches en retard (événement TASK_OVERDUE, max 1/jour)
  const overdue = db.prepare("SELECT * FROM tasks WHERE status IN ('TODO','IN_PROGRESS') AND due_date IS NOT NULL AND date(due_date) < date('now')").all();
  for (const t of overdue) {
    const recent = db.prepare("SELECT 1 n FROM sales_events WHERE organization_id = ? AND type = 'TASK_OVERDUE' AND entity_id = ? AND created_at > datetime('now', '-1 day') LIMIT 1").get(t.organization_id, t.id);
    if (recent) continue;
    stats.overdue_tasks++;
    const ev = emitEvent(db, t.organization_id, { type: "TASK_OVERDUE", entity_type: "task", entity_id: t.id, lead_id: t.lead_id || null, payload: { task_id: t.id, title: t.title, due_date: t.due_date } });
    await processEvent(db, ev);
    if (t.assigned_to) notifyUser(db, { orgId: t.organization_id, userId: t.assigned_to, type: "AUTOMATION", title: "Tâche en retard", message: t.title, link: t.lead_id ? `/dashboard/leads/${t.lead_id}` : "/dashboard/tasks", leadId: t.lead_id || null });
  }

  return stats;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

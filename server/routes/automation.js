// server/routes/automation.js — Phase 5 : API du moteur d'automatisation
// Automations, séquences, follow-ups, campagnes, segments, notifications,
// analytics, prédiction (readiness), settings, règles d'assignation.
// Toutes tenant-scopées ; écritures protégées par permissions ; tick de test
// uniquement en APP_ENV=test.

import { randomUUID } from "node:crypto";
import { checkLimit } from "../billing.js";
import { can } from "../rbac.js";
import { logAudit } from "../audit.js";
import { cleanText, nowIso, isValidEmail } from "../security.js";
import { EVENT_TYPES } from "../automation/events.js";
import { CHANNELS } from "../automation/channels.js";
import { channelStatus } from "../automation/channels.js";
import {
  processEvent, tick, enrollLeadInSequence, cancelFollowUpsForLead,
  orgAutomationSettings, notifyUser, notifiableMembers, smartAssign, loadLeadContext,
} from "../automation/engine.js";
import { parseWait, scheduleFollowUp, getPreferences, setOptOut, TEMPLATE_VARS } from "../automation/followup.js";
import { getProvider } from "../automation/channels.js";
import { predictionReadiness, getPredictionProvider } from "../automation/prediction.js";
import { emitEvent } from "../automation/events.js";
import { automationsPage, sequencesPage, campaignsPage, followupsPage, automationAnalyticsPage } from "../views/automation.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

const AUTOMATION_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];
const SEQUENCE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];
const CONDITIONS_FIELDS = ["lead.score", "lead.status", "lead.priority", "lead.intent", "lead.source", "lead.budget", "lead.created_at", "lead.hot", "lead.at_risk", "deal.value", "deal.stage", "customer.country", "customer.city", "last_activity", "last_response", "product.category"];
const OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "contains", "not_contains", "in", "not_in"];
const ACTIONS = ["CREATE_TASK", "UPDATE_LEAD", "UPDATE_SCORE", "ADD_NOTE", "CREATE_ACTIVITY", "SEND_EMAIL", "SEND_MESSAGE", "ASSIGN_LEAD", "CREATE_DEAL", "NOTIFY_SALES_AGENT", "HANDOFF_HUMAN", "START_SEQUENCE", "STOP_SEQUENCE"];
const APPROVAL_MODES = ["AUTO", "APPROVAL_REQUIRED", "MANUAL"];
const ASSIGN_STRATEGIES = ["ROUND_ROBIN", "WORKLOAD", "TERRITORY", "LANGUAGE", "PRODUCT"];

/* ---------- multi-tenant : re-scope (membre uniquement, sinon 403) ---------- */
function scopedOrg(ctx) {
  const requested = ctx.query.organization_id;
  if (requested) {
    const m = isUuid(requested) ? ctx.db.prepare("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?").get(requested, ctx.user.id) : null;
    if (!m) return { org: null, member: null, forbidden: true };
    const org = ctx.db.prepare("SELECT * FROM organizations WHERE id = ?").get(requested);
    if (!org) return { org: null, member: null, forbidden: true };
    return { org, member: m, forbidden: false };
  }
  if (!ctx.org || !ctx.member) return { org: null, member: null, forbidden: true };
  return { org: ctx.org, member: ctx.member, forbidden: false };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/* ============================ PAGES ============================ */
export async function handlePage(ctx) {
  const { path } = ctx;
  if (!path.startsWith("/dashboard/")) return false;
  if (!ctx.user || !ctx.org || !ctx.member) { ctx.redirect("/login"); return true; }
  const { user, org, member, csrf, db } = ctx;
  const pageCtx = () => ({ user, org, role: member.role, csrf, db });

  if (path === "/dashboard/automations") {
    const automations = db.prepare("SELECT * FROM automations WHERE organization_id = ? ORDER BY updated_at DESC").all(org.id);
    const channels = channelStatus();
    const { followup_mode } = orgAutomationSettings(db, org);
    return ctx.sendHTML(200, automationsPage(pageCtx(), { automations, channels, followup_mode, EVENT_TYPES, CONDITIONS_FIELDS, OPERATORS, ACTIONS }));
  }
  if (path === "/dashboard/sequences") {
    const sequences = db.prepare("SELECT * FROM sequences WHERE organization_id = ? ORDER BY updated_at DESC").all(org.id);
    const enrollments = db.prepare("SELECT * FROM sequence_enrollments WHERE organization_id = ? ORDER BY enrolled_at DESC LIMIT 100").all(org.id);
    return ctx.sendHTML(200, sequencesPage(pageCtx(), { sequences, enrollments, CHANNELS }));
  }
  if (path === "/dashboard/campaigns") {
    const campaigns = db.prepare("SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC").all(org.id);
    const segments = db.prepare("SELECT * FROM segments WHERE organization_id = ? ORDER BY created_at DESC").all(org.id);
    const templates = db.prepare("SELECT * FROM message_templates WHERE organization_id = ? AND status = 'ACTIVE' ORDER BY name").all(org.id);
    return ctx.sendHTML(200, campaignsPage(pageCtx(), { campaigns, segments, templates, CHANNELS }));
  }
  if (path === "/dashboard/followups") {
    const pending = db.prepare("SELECT * FROM followup_history WHERE organization_id = ? AND status IN ('SCHEDULED','PENDING_APPROVAL','DRAFTED') ORDER BY scheduled_at ASC LIMIT 100").all(org.id);
    const history = db.prepare("SELECT * FROM followup_history WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200").all(org.id);
    const { followup_mode } = orgAutomationSettings(db, org);
    return ctx.sendHTML(200, followupsPage(pageCtx(), { pending, history, followup_mode, CHANNELS }));
  }
  if (path === "/dashboard/automation/analytics") {
    const analytics = computeAnalytics(db, org.id);
    const readiness = predictionReadiness(db, org);
    return ctx.sendHTML(200, automationAnalyticsPage(pageCtx(), { analytics, readiness }));
  }
  return false;
}

/* ============================ ANALYTICS ============================ */
function computeAnalytics(db, orgId) {
  const automations = db.prepare("SELECT * FROM automations WHERE organization_id = ?").all(orgId);
  const logs = db.prepare("SELECT * FROM automation_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1000").all(orgId);
  const byStatus = { SUCCESS: 0, FAILED: 0, SKIPPED: 0, CANCELLED: 0 };
  for (const l of logs) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  const messages = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) sent,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) cancelled,
      SUM(CASE WHEN response_at IS NOT NULL THEN 1 ELSE 0 END) replied,
      COUNT(*) total
    FROM followup_history WHERE organization_id = ?`).get(orgId);
  const followups = {
    scheduled: db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND status = 'SCHEDULED'").get(orgId).n,
    pending_approval: db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND status = 'PENDING_APPROVAL'").get(orgId).n,
    drafted: db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND status = 'DRAFTED'").get(orgId).n,
    sent: messages.sent || 0, failed: messages.failed || 0, cancelled: messages.cancelled || 0, replied: messages.replied || 0,
    total: messages.total || 0,
  };
  // Séquences : contacts, envoyés, réponses, qualification, conversion, arrêtés
  const sequences = db.prepare("SELECT * FROM sequences WHERE organization_id = ?").all(orgId).map((s) => {
    const enrolled = db.prepare("SELECT * FROM sequence_enrollments WHERE organization_id = ? AND sequence_id = ?").all(orgId, s.id);
    const leads = new Set(enrolled.map((e) => e.lead_id));
    const sent = db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND sequence_id = ? AND status = 'SENT'").get(orgId, s.id).n;
    const replied = db.prepare("SELECT COUNT(*) n FROM followup_history WHERE organization_id = ? AND sequence_id = ? AND response_at IS NOT NULL").get(orgId, s.id).n;
    const qualified = [...leads].filter((lid) => { const l = db.prepare("SELECT score, status FROM leads WHERE id = ?").get(lid); return l && (l.score >= 61 || ["QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION"].includes(l.status)); }).length;
    const converted = [...leads].filter((lid) => { const l = db.prepare("SELECT status FROM leads WHERE id = ?").get(lid); return l && l.status === "WON"; }).length;
    const stopped = enrolled.filter((e) => e.status === "STOPPED").length;
    const contacts = enrolled.length;
    const rate = (n) => (contacts > 0 ? Math.round((n / contacts) * 1000) / 10 : null);
    return {
      id: s.id, name: s.name, status: s.status, contacts, sent, replied, qualified, converted, stopped,
      response_rate: rate(replied), qualification_rate: rate(qualified), conversion_rate: rate(converted),
    };
  });
  // Revenue associé (spec §46) : deals WON du lead ayant au moins un follow-up envoyé
  // ou une séquence active — « revenue associé », jamais « revenue causé par l'IA ».
  const revenue = db.prepare(`
    SELECT COALESCE(SUM(d.value), 0) total, COUNT(*) deals
    FROM deals d
    WHERE d.organization_id = ? AND d.stage = 'WON' AND d.lead_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM followup_history f WHERE f.organization_id = d.organization_id AND f.lead_id = d.lead_id AND f.status = 'SENT'
        UNION
        SELECT 1 FROM sequence_enrollments e WHERE e.organization_id = d.organization_id AND e.lead_id = d.lead_id
      )`).get(orgId);
  return {
    automations: { total: automations.length, active: automations.filter((a) => a.status === "ACTIVE").length, executions: logs.length, ...byStatus },
    messages: followups,
    sequences,
    revenue_associated: { total: revenue.total, deals: revenue.deals, label: "Revenue associé (influence documentée)" },
  };
}

/* ============================ API ============================ */
export async function handleApi(ctx) {
  const { path, method, body, db } = ctx;
  if (!path.startsWith("/api/")) return false;
  if (!ctx.user) return ctx.sendJSON(401, { error: "Connexion requise." });
  const { org, member, forbidden } = scopedOrg(ctx);
  if (forbidden) return ctx.sendJSON(403, { error: "Accès refusé à cette organisation." });
  const read = can(member.role, "automation:read");
  const manage = can(member.role, "automation:manage");

  /* ---------- Notifications (personnes) ---------- */
  if (path === "/api/notifications" && method === "GET") {
    const rows = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 50").all(ctx.user.id, org.id);
    const unread = db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND organization_id = ? AND read = 0").get(ctx.user.id, org.id).n;
    return ctx.sendJSON(200, { notifications: rows, unread });
  }
  const notifRead = path.match(/^\/api\/notifications\/([0-9a-f-]+)\/read$/i);
  if (notifRead && method === "POST") {
    const n = isUuid(notifRead[1]) ? db.prepare("SELECT * FROM notifications WHERE id = ? AND user_id = ? AND organization_id = ?").get(notifRead[1], ctx.user.id, org.id) : null;
    if (!n) return ctx.sendJSON(404, { error: "Notification introuvable." });
    db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(n.id);
    return ctx.sendJSON(200, { message: "Marquée comme lue." });
  }

  /* ---------- Canal status + settings d'automatisation ---------- */
  if (path === "/api/automation/channels" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    return ctx.sendJSON(200, { channels: channelStatus() });
  }
  if (path === "/api/automation/settings" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const s = orgAutomationSettings(db, org);
    const limits = db.prepare("SELECT * FROM communication_limits WHERE organization_id = ?").get(org.id)
      || { organization_id: org.id, max_per_day: 2, max_per_week: 5, min_interval_minutes: 60, max_followups: 4 };
    return ctx.sendJSON(200, { followup_mode: s.followup_mode, business_hours: s.business_hours, ml_min_resolved: s.ml_min_resolved, limits, timezone: org.timezone });
  }
  if (path === "/api/automation/settings" && method === "PUT") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    const settings = org.settings ? safeParse(org.settings, {}) : {};
    if (body.followup_mode !== undefined) {
      if (!APPROVAL_MODES.includes(body.followup_mode)) return ctx.sendJSON(400, { error: "Mode invalide (AUTO | APPROVAL_REQUIRED | MANUAL)." });
      settings.followup_mode = body.followup_mode;
    }
    if (body.business_hours !== undefined) {
      const bh = body.business_hours;
      if (!Array.isArray(bh.days) || bh.days.length < 1 || bh.days.length > 7 || !bh.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return ctx.sendJSON(400, { error: "Jours invalides (0-6)." });
      const open = Number(bh.open), close = Number(bh.close);
      if (!Number.isFinite(open) || !Number.isFinite(close) || open < 0 || close > 24 * 60 || open >= close) return ctx.sendJSON(400, { error: "Horaires invalides (minutes, open < close)." });
      settings.business_hours = { days: bh.days, open, close };
    }
    if (body.ml_min_resolved !== undefined) {
      const n = Math.max(10, Number(body.ml_min_resolved) || 100);
      settings.ml_min_resolved = n;
    }
    if (body.timezone !== undefined) {
      const tz = String(body.timezone || "").slice(0, 64);
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return ctx.sendJSON(400, { error: "Timezone invalide." }); }
      db.prepare("UPDATE organizations SET timezone = ?, updated_at = ? WHERE id = ?").run(tz, nowIso(), org.id);
    }
    db.prepare("UPDATE organizations SET settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(settings), nowIso(), org.id);
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_AUTOMATION_SETTINGS", resourceType: "organization", resourceId: org.id, metadata: { fields: Object.keys(body) } });
    const fresh = db.prepare("SELECT * FROM organizations WHERE id = ?").get(org.id);
    return ctx.sendJSON(200, { message: "Paramètres mis à jour.", ...orgAutomationSettings(db, fresh) });
  }

  /* ---------- Limites anti-spam ---------- */
  if (path === "/api/automation/limits" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const limits = db.prepare("SELECT * FROM communication_limits WHERE organization_id = ?").get(org.id)
      || { organization_id: org.id, max_per_day: 2, max_per_week: 5, min_interval_minutes: 60, max_followups: 4 };
    return ctx.sendJSON(200, { limits });
  }
  if (path === "/api/automation/limits" && method === "PUT") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    const int = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null; };
    const md = body.max_per_day !== undefined ? int(body.max_per_day, 0, 100) : null;
    const mw = body.max_per_week !== undefined ? int(body.max_per_week, 0, 500) : null;
    const mi = body.min_interval_minutes !== undefined ? int(body.min_interval_minutes, 0, 7 * 24 * 60) : null;
    const mf = body.max_followups !== undefined ? int(body.max_followups, 0, 100) : null;
    if ((body.max_per_day !== undefined && md === null) || (body.max_per_week !== undefined && mw === null) || (body.min_interval_minutes !== undefined && mi === null) || (body.max_followups !== undefined && mf === null)) {
      return ctx.sendJSON(400, { error: "Valeurs de limites invalides." });
    }
    // Lecture AVANT écriture : un PUT partiel ne doit pas écraser les autres limites
    const existing = db.prepare("SELECT * FROM communication_limits WHERE organization_id = ?").get(org.id);
    const base = existing || { max_per_day: 2, max_per_week: 5, min_interval_minutes: 60, max_followups: 4 };
    db.prepare(
      `INSERT INTO communication_limits (organization_id, max_per_day, max_per_week, min_interval_minutes, max_followups)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET max_per_day = excluded.max_per_day, max_per_week = excluded.max_per_week, min_interval_minutes = excluded.min_interval_minutes, max_followups = excluded.max_followups`
    ).run(org.id, md ?? base.max_per_day, mw ?? base.max_per_week, mi ?? base.min_interval_minutes, mf ?? base.max_followups);
    return ctx.sendJSON(200, { limits: db.prepare("SELECT * FROM communication_limits WHERE organization_id = ?").get(org.id) });
  }

  /* ---------- Automations (spec §3, §6) ---------- */
  if (path === "/api/automations") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare("SELECT * FROM automations WHERE organization_id = ? ORDER BY updated_at DESC").all(org.id);
      return ctx.sendJSON(200, {
        automations: rows.map((a) => ({ ...a, conditions: safeParse(a.conditions, []), actions: safeParse(a.actions, []) })),
        EVENT_TYPES, CONDITIONS_FIELDS, OPERATORS, ACTIONS,
      });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      // Phase 8 — limite du plan (automations actives)
      const limAuto = checkLimit(db, org.id, "automations");
      if (!limAuto.ok) return ctx.sendJSON(403, { error: limAuto.error, plan: limAuto.plan, limit: limAuto.limit, used: limAuto.used });
      const v = validateAutomation(body);
      if (v.error) return ctx.sendJSON(400, { error: v.error });
      const id = randomUUID();
      const now = nowIso();
      const status = ["DRAFT", "ACTIVE", "PAUSED"].includes(body.status) ? body.status : "DRAFT";
      db.prepare(
        `INSERT INTO automations (id, organization_id, name, description, status, trigger, conditions, actions, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, org.id, v.name, cleanText(body.description, 300) || null, status, v.trigger, JSON.stringify(v.conditions), JSON.stringify(v.actions), ctx.user.id, now, now);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_AUTOMATION", resourceType: "automation", resourceId: id, metadata: { trigger: v.trigger, actions: v.actions.map((a) => a.action) } });
      return ctx.sendJSON(201, { id, status, message: "Automation créée." });
    }
  }
  const autoId = path.match(/^\/api\/automations\/([0-9a-f-]+)(\/(test|activate|pause))?$/i);
  if (autoId) {
    const a = isUuid(autoId[1]) ? db.prepare("SELECT * FROM automations WHERE id = ? AND organization_id = ?").get(autoId[1], org.id) : null;
    if (!a) return ctx.sendJSON(404, { error: "Automation introuvable." });
    const sub = autoId[3];
    if (method === "GET" && !sub) {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const logs = db.prepare("SELECT * FROM automation_logs WHERE organization_id = ? AND automation_id = ? ORDER BY created_at DESC LIMIT 100").all(org.id, a.id);
      return ctx.sendJSON(200, { automation: { ...a, conditions: safeParse(a.conditions, []), actions: safeParse(a.actions, []) }, logs });
    }
    if (method === "PUT") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      // PUT partiel : les champs non fournis conservent leur valeur
      const v = validateAutomation({ ...a, ...body, name: body.name ?? a.name, trigger: body.trigger ?? a.trigger, conditions: body.conditions ?? safeParse(a.conditions, []), actions: body.actions ?? safeParse(a.actions, []) });
      if (v.error) return ctx.sendJSON(400, { error: v.error });
      const status = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"].includes(body.status) ? body.status : a.status;
      db.prepare("UPDATE automations SET name = ?, description = ?, status = ?, trigger = ?, conditions = ?, actions = ?, updated_at = ? WHERE id = ?")
        .run(v.name, body.description !== undefined ? (cleanText(body.description, 300) || null) : a.description, status, v.trigger, JSON.stringify(v.conditions), JSON.stringify(v.actions), nowIso(), a.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "UPDATE_AUTOMATION", resourceType: "automation", resourceId: a.id, metadata: { status } });
      return ctx.sendJSON(200, { message: "Automation mise à jour.", status });
    }
    if (method === "DELETE") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      db.prepare("DELETE FROM automations WHERE id = ? AND organization_id = ?").run(a.id, org.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "DELETE_AUTOMATION", resourceType: "automation", resourceId: a.id });
      return ctx.sendJSON(200, { message: "Automation supprimée." });
    }
    if (method === "POST" && sub === "activate") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      db.prepare("UPDATE automations SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(nowIso(), a.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "ACTIVATE_AUTOMATION", resourceType: "automation", resourceId: a.id });
      return ctx.sendJSON(200, { message: "Automation activée.", status: "ACTIVE" });
    }
    if (method === "POST" && sub === "pause") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      db.prepare("UPDATE automations SET status = 'PAUSED', updated_at = ? WHERE id = ?").run(nowIso(), a.id);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "PAUSE_AUTOMATION", resourceType: "automation", resourceId: a.id });
      return ctx.sendJSON(200, { message: "Automation en pause.", status: "PAUSED" });
    }
    if (method === "POST" && sub === "test") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      // Test à blanc : évalue les conditions sur un lead d'exemple SANS exécuter les actions
      const leadId = isUuid(body.lead_id) ? body.lead_id : null;
      const context = leadId ? loadLeadContext(db, org.id, leadId) : { lead: null, deal: null, customer: null, product: null };
      const conditions = safeParse(a.conditions, []);
      const { allConditionsPass } = await import("../automation/engine.js");
      const pass = allConditionsPass(context, conditions);
      return ctx.sendJSON(200, {
        lead_id: leadId,
        conditions_met: pass,
        would_execute: pass ? safeParse(a.actions, []).map((x) => x.action) : [],
        lead: context.lead ? { name: context.lead.name, score: context.lead.score, status: context.lead.status, priority: context.lead.priority, purchase_intent: context.lead.purchase_intent, budget: context.lead.budget } : null,
        note: "Test à blanc : aucune action n'a été exécutée.",
      });
    }
  }

  /* ---------- Séquences (spec §9) ---------- */
  if (path === "/api/sequences") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare("SELECT * FROM sequences WHERE organization_id = ? ORDER BY updated_at DESC").all(org.id);
      return ctx.sendJSON(200, { sequences: rows.map((s) => ({ ...s, steps: safeParse(s.steps, []) })) });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = cleanText(body.name, 120);
      if (!name) return ctx.sendJSON(400, { error: "Nom requis." });
      const channel = String(body.channel || "WEBCHAT").toUpperCase();
      if (!CHANNELS.includes(channel)) return ctx.sendJSON(400, { error: "Canal invalide." });
      const steps = Array.isArray(body.steps) ? body.steps : null;
      if (!steps || !steps.length) return ctx.sendJSON(400, { error: "Au moins une étape est requise." });
      for (const [i, s] of steps.entries()) {
        const wait = parseWait(s.wait || "1d");
        if (wait === null) return ctx.sendJSON(400, { error: `Étape ${i + 1} : délai invalide (immediate, 5m, 15m, 1h, 1d, 2d, 3d, 7d ou personnalisé).` });
        if (!String(s.content || "").trim() && !isUuid(s.template_id)) return ctx.sendJSON(400, { error: `Étape ${i + 1} : message ou template requis.` });
      }
      const id = randomUUID();
      const now = nowIso();
      const status = ["DRAFT", "ACTIVE"].includes(body.status) ? body.status : "DRAFT";
      db.prepare(
        `INSERT INTO sequences (id, organization_id, name, description, status, channel, steps, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, org.id, name, cleanText(body.description, 300) || null, status, channel, JSON.stringify(steps.map((s) => ({ wait: s.wait || "1d", subject: cleanText(s.subject, 200) || null, content: String(s.content || "").slice(0, 2000), template_id: isUuid(s.template_id) ? s.template_id : null }))), ctx.user.id, now, now);
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "CREATE_SEQUENCE", resourceType: "sequence", resourceId: id, metadata: { steps: steps.length, channel } });
      return ctx.sendJSON(201, { id, status, message: "Séquence créée." });
    }
  }
  const seqId = path.match(/^\/api\/sequences\/([0-9a-f-]+)(\/start)?$/i);
  if (seqId) {
    const s = isUuid(seqId[1]) ? db.prepare("SELECT * FROM sequences WHERE id = ? AND organization_id = ?").get(seqId[1], org.id) : null;
    if (!s) return ctx.sendJSON(404, { error: "Séquence introuvable." });
    if (method === "PUT") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = body.name !== undefined ? cleanText(body.name, 120) : s.name;
      if (!name) return ctx.sendJSON(400, { error: "Nom requis." });
      const channel = body.channel !== undefined ? String(body.channel).toUpperCase() : s.channel;
      if (!CHANNELS.includes(channel)) return ctx.sendJSON(400, { error: "Canal invalide." });
      let steps = safeParse(s.steps, []);
      if (body.steps !== undefined) {
        if (!Array.isArray(body.steps) || !body.steps.length) return ctx.sendJSON(400, { error: "Au moins une étape est requise." });
        for (const [i, st] of body.steps.entries()) {
          if (parseWait(st.wait || "1d") === null) return ctx.sendJSON(400, { error: `Étape ${i + 1} : délai invalide.` });
          if (!String(st.content || "").trim() && !isUuid(st.template_id)) return ctx.sendJSON(400, { error: `Étape ${i + 1} : message ou template requis.` });
        }
        steps = body.steps.map((st) => ({ wait: st.wait || "1d", subject: cleanText(st.subject, 200) || null, content: String(st.content || "").slice(0, 2000), template_id: isUuid(st.template_id) ? st.template_id : null }));
      }
      const status = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"].includes(body.status) ? body.status : s.status;
      db.prepare("UPDATE sequences SET name = ?, channel = ?, steps = ?, status = ?, updated_at = ? WHERE id = ?").run(name, channel, JSON.stringify(steps), status, nowIso(), s.id);
      return ctx.sendJSON(200, { message: "Séquence mise à jour.", status });
    }
    if (method === "DELETE") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      db.prepare("DELETE FROM sequences WHERE id = ? AND organization_id = ?").run(s.id, org.id);
      return ctx.sendJSON(200, { message: "Séquence supprimée." });
    }
    if (method === "POST" && path.endsWith("/start")) {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      if (s.status !== "ACTIVE") return ctx.sendJSON(400, { error: "Activez d'abord la séquence." });
      const leadIds = (Array.isArray(body.lead_ids) ? body.lead_ids : []).filter(isUuid);
      if (!leadIds.length) return ctx.sendJSON(400, { error: "Aucun lead indiqué (lead_ids)." });
      let enrolled = 0, skipped = 0;
      for (const lid of leadIds) {
        const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(lid, org.id);
        if (!lead || ["WON", "LOST"].includes(lead.status)) { skipped++; continue; }
        if (getPreferences(db, org.id, lead).marketing === 0) { skipped++; continue; }
        enrollLeadInSequence(db, org.id, s, lid);
        enrolled++;
      }
      logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "START_SEQUENCE", resourceType: "sequence", resourceId: s.id, metadata: { enrolled, skipped } });
      return ctx.sendJSON(200, { message: `Séquence démarrée : ${enrolled} lead(s) inscrit(s), ${skipped} ignoré(s).`, enrolled, skipped });
    }
  }

  /* ---------- Follow-ups (spec §7, §17, §18) ---------- */
  if (path === "/api/followups") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const status = body?.status || ctx.query.status;
      const rows = status
        ? db.prepare("SELECT * FROM followup_history WHERE organization_id = ? AND status = ? ORDER BY scheduled_at ASC LIMIT 200").all(org.id, String(status).toUpperCase())
        : db.prepare("SELECT * FROM followup_history WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200").all(org.id);
      return ctx.sendJSON(200, { followups: rows });
    }
    if (method === "POST") {
      if (!can(member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
      const lead = isUuid(body.lead_id) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(body.lead_id, org.id) : null;
      if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
      if (["WON", "LOST"].includes(lead.status)) return ctx.sendJSON(400, { error: `Lead ${lead.status} : aucun follow-up commercial.` });
      const channel = String(body.channel || "WEBCHAT").toUpperCase();
      if (!CHANNELS.includes(channel)) return ctx.sendJSON(400, { error: "Canal invalide." });
      let message = String(body.message || "").slice(0, 2000);
      if (isUuid(body.template_id)) {
        const t = db.prepare("SELECT * FROM message_templates WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'").get(body.template_id, org.id);
        if (t) message = message || t.content;
      }
      if (!message.trim()) return ctx.sendJSON(400, { error: "Message (ou template) requis." });
      const waitMs = body.wait !== undefined ? (parseWait(body.wait) ?? 0) : 0;
      const entry = scheduleFollowUp(db, { org, lead, channel, subject: cleanText(body.subject, 200) || null, message, reason: cleanText(body.reason, 300) || "Relance manuelle", waitMs });
      emitEvent(db, org.id, { type: "FOLLOWUP_SCHEDULED", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { followup_id: entry.id, channel } });
      return ctx.sendJSON(201, { id: entry.id, scheduled_at: entry.scheduled_at, message: "Follow-up planifié." });
    }
  }
  const followupId = path.match(/^\/api\/followups\/([0-9a-f-]+)\/(approve|cancel)$/i);
  if (followupId && method === "POST") {
    const f = isUuid(followupId[1]) ? db.prepare("SELECT * FROM followup_history WHERE id = ? AND organization_id = ?").get(followupId[1], org.id) : null;
    if (!f) return ctx.sendJSON(404, { error: "Follow-up introuvable." });
    const action = followupId[2];
    if (action === "cancel") {
      if (!can(member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
      if (!["SCHEDULED", "PENDING_APPROVAL", "DRAFTED"].includes(f.status)) return ctx.sendJSON(400, { error: `Statut ${f.status} : annulation impossible.` });
      db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'annulé par le commercial' WHERE id = ?").run(f.id);
      emitEvent(db, org.id, { type: "FOLLOWUP_CANCELLED", entity_type: "lead", entity_id: f.lead_id, lead_id: f.lead_id, payload: { followup_id: f.id, by: ctx.user.id } });
      return ctx.sendJSON(200, { message: "Follow-up annulé." });
    }
    if (action === "approve") {
      if (!can(member.role, "crm:write")) return ctx.sendJSON(403, { error: "Permission insuffisante (crm:write)." });
      if (f.status !== "PENDING_APPROVAL") return ctx.sendJSON(400, { error: `Statut ${f.status} : approval attendue en PENDING_APPROVAL.` });
      const lead = db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(f.lead_id, org.id);
      if (!lead || ["WON", "LOST"].includes(lead.status)) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'lead clos' WHERE id = ?").run(f.id); return ctx.sendJSON(200, { message: "Lead clos : follow-up annulé.", status: "CANCELLED" }); }
      const prefs = getPreferences(db, org.id, lead);
      if (prefs.marketing === 0) { db.prepare("UPDATE followup_history SET status = 'CANCELLED', cancel_reason = 'opt-out' WHERE id = ?").run(f.id); return ctx.sendJSON(200, { message: "Opt-out : envoi refusé.", status: "CANCELLED" }); }
      const provider = getProvider(f.channel);
      if (!provider || !provider.configured()) {
        db.prepare("UPDATE followup_history SET status = 'FAILED', error = 'Canal non configuré.' WHERE id = ?").run(f.id);
        return ctx.sendJSON(200, { message: "Canal non configuré.", status: "FAILED" });
      }
      const sent = provider.send(db, { leadId: lead.id, subject: f.subject, content: f.message, orgId: org.id, conversationId: lead.conversation_id });
      if (sent.status === "sent") {
        db.prepare("UPDATE followup_history SET status = 'SENT', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(nowIso(), f.id);
        emitEvent(db, org.id, { type: "FOLLOWUP_SENT", entity_type: "lead", entity_id: lead.id, lead_id: lead.id, payload: { followup_id: f.id, approved_by: ctx.user.id } });
        return ctx.sendJSON(200, { message: "Approuvé et envoyé.", status: "SENT" });
      }
      db.prepare("UPDATE followup_history SET status = 'FAILED', error = ? WHERE id = ?").run(sent.error || "échec d'envoi", f.id);
      return ctx.sendJSON(200, { message: sent.error || "Échec d'envoi.", status: "FAILED" });
    }
  }

  /* ---------- Segments (spec §28) ---------- */
  if (path === "/api/segments") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare("SELECT * FROM segments WHERE organization_id = ? ORDER BY created_at DESC").all(org.id);
      return ctx.sendJSON(200, { segments: rows.map((s) => ({ ...s, definition: safeParse(s.definition, {}), count: segmentCount(db, org.id, safeParse(s.definition, {})) })) });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = cleanText(body.name, 120);
      if (!name) return ctx.sendJSON(400, { error: "Nom requis." });
      const definition = validateSegment(body.definition);
      const id = randomUUID();
      const now = nowIso();
      db.prepare("INSERT INTO segments (id, organization_id, name, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, org.id, name, JSON.stringify(definition), now, now);
      return ctx.sendJSON(201, { id, count: segmentCount(db, org.id, definition) });
    }
  }
  const segId = path.match(/^\/api\/segments\/([0-9a-f-]+)$/i);
  if (segId && method === "DELETE") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    db.prepare("DELETE FROM segments WHERE id = ? AND organization_id = ?").run(segId[1], org.id);
    return ctx.sendJSON(200, { message: "Segment supprimé." });
  }

  /* ---------- Campagnes (spec §27) ---------- */
  if (path === "/api/campaigns") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare("SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC").all(org.id);
      return ctx.sendJSON(200, { campaigns: rows });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = cleanText(body.name, 120);
      if (!name) return ctx.sendJSON(400, { error: "Nom requis." });
      const segment = isUuid(body.segment_id) ? db.prepare("SELECT * FROM segments WHERE id = ? AND organization_id = ?").get(body.segment_id, org.id) : null;
      if (!segment) return ctx.sendJSON(400, { error: "Segment requis (segment_id)." });
      const channel = String(body.channel || "WEBCHAT").toUpperCase();
      if (!CHANNELS.includes(channel)) return ctx.sendJSON(400, { error: "Canal invalide." });
      const template = isUuid(body.template_id) ? db.prepare("SELECT * FROM message_templates WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'").get(body.template_id, org.id) : null;
      if (!template) return ctx.sendJSON(400, { error: "Template requis (template_id)." });
      const maxRecipients = Math.max(1, Math.min(10000, Number(body.max_recipients) || 500));
      const id = randomUUID();
      const now = nowIso();
      db.prepare(
        `INSERT INTO campaigns (id, organization_id, name, description, status, segment_id, channel, template_id, max_recipients, created_by, created_at)
         VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`
      ).run(id, org.id, name, cleanText(body.description, 300) || null, segment.id, channel, template.id, maxRecipients, ctx.user.id, now);
      return ctx.sendJSON(201, { id, message: "Campagne créée (brouillon)." });
    }
  }
  const campId = path.match(/^\/api\/campaigns\/([0-9a-f-]+)\/start$/i);
  if (campId && method === "POST") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    const c = isUuid(campId[1]) ? db.prepare("SELECT * FROM campaigns WHERE id = ? AND organization_id = ?").get(campId[1], org.id) : null;
    if (!c) return ctx.sendJSON(404, { error: "Campagne introuvable." });
    if (c.status === "COMPLETED") return ctx.sendJSON(400, { error: "Campagne déjà terminée." });
    const segment = db.prepare("SELECT * FROM segments WHERE id = ? AND organization_id = ?").get(c.segment_id, org.id);
    const template = db.prepare("SELECT * FROM message_templates WHERE id = ? AND organization_id = ?").get(c.template_id, org.id);
    if (!segment || !template) return ctx.sendJSON(400, { error: "Segment ou template manquant." });
    const def = safeParse(segment.definition, {});
    const leads = segmentLeads(db, org.id, def, c.max_recipients);
    if (!leads.length) return ctx.sendJSON(400, { error: "Aucun lead ne correspond au segment." });
    const provider = getProvider(c.channel);
    if (!provider || !provider.configured()) {
      // Ne PAS simuler : on planifie, le tick échouera honnêtement (« Canal non configuré. »)
    }
    let sent = 0, skipped = 0;
    const { templateVars, renderTemplate } = await import("../automation/followup.js");
    for (const lead of leads) {
      if (["WON", "LOST"].includes(lead.status)) { skipped++; continue; }
      const prefs = getPreferences(db, org.id, lead);
      if (prefs.marketing === 0) { skipped++; continue; }
      const context = loadLeadContext(db, org.id, lead.id);
      const vars = templateVars(db, org.id, lead, { product: context.product, deal: context.deal });
      const rendered = renderTemplate(db, org.id, { template_id: template.id }, vars);
      scheduleFollowUp(db, { org, lead, channel: c.channel, subject: rendered.subject, message: rendered.content || template.content, reason: `Campagne « ${c.name} »`, campaign_id: c.id, scheduledAtIso: nowIso() });
      sent++;
    }
    db.prepare("UPDATE campaigns SET status = 'ACTIVE', recipients_count = ?, sent_count = ?, started_at = ? WHERE id = ?").run(leads.length, sent, nowIso(), c.id);
    emitEvent(db, org.id, { type: "CAMPAIGN_STARTED", entity_type: "campaign", entity_id: c.id, payload: { name: c.name, recipients: leads.length, sent, skipped } });
    logAudit(db, { organizationId: org.id, userId: ctx.user.id, action: "START_CAMPAIGN", resourceType: "campaign", resourceId: c.id, metadata: { recipients: leads.length, sent, skipped } });
    return ctx.sendJSON(200, { message: `Campagne démarrée : ${sent} message(s) planifié(s), ${skipped} ignoré(s).`, sent, skipped });
  }

  /* ---------- Templates de message (spec §15) ---------- */
  if (path === "/api/message-templates") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      return ctx.sendJSON(200, { templates: db.prepare("SELECT * FROM message_templates WHERE organization_id = ? ORDER BY name").all(org.id), TEMPLATE_VARS });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = cleanText(body.name, 120);
      const content = String(body.content || "").trim();
      if (!name || !content) return ctx.sendJSON(400, { error: "Nom et contenu requis." });
      const channel = String(body.channel || "EMAIL").toUpperCase();
      if (!CHANNELS.includes(channel)) return ctx.sendJSON(400, { error: "Canal invalide." });
      const id = randomUUID();
      const now = nowIso();
      db.prepare(
        `INSERT INTO message_templates (id, organization_id, name, channel, subject, content, language, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
      ).run(id, org.id, name, channel, cleanText(body.subject, 200) || null, content.slice(0, 4000), String(body.language || "fr").slice(0, 8), now, now);
      return ctx.sendJSON(201, { id, message: "Template créé." });
    }
  }
  const tplId = path.match(/^\/api\/message-templates\/([0-9a-f-]+)$/i);
  if (tplId && method === "DELETE") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    db.prepare("DELETE FROM message_templates WHERE id = ? AND organization_id = ?").run(tplId[1], org.id);
    return ctx.sendJSON(200, { message: "Template supprimé." });
  }

  /* ---------- Règles d'assignation (spec §21) ---------- */
  if (path === "/api/assignment-rules") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare("SELECT * FROM assignment_rules WHERE organization_id = ? ORDER BY created_at").all(org.id);
      return ctx.sendJSON(200, { rules: rows.map((r) => ({ ...r, team_member_ids: safeParse(r.team_member_ids, []) })), STRATEGIES: ASSIGN_STRATEGIES });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = cleanText(body.name, 120);
      if (!name) return ctx.sendJSON(400, { error: "Nom requis." });
      const strategy = ASSIGN_STRATEGIES.includes(body.strategy) ? body.strategy : "ROUND_ROBIN";
      const team = (Array.isArray(body.team_member_ids) ? body.team_member_ids : []).filter(isUuid);
      if (!team.length) return ctx.sendJSON(400, { error: "Au moins un membre d'équipe est requis." });
      for (const uid of team) {
        if (!db.prepare("SELECT 1 n FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'").get(org.id, uid)) {
          return ctx.sendJSON(400, { error: "Membre d'équipe introuvable dans l'organisation." });
        }
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO assignment_rules (id, organization_id, name, strategy, team_member_ids, language, product_category, min_deal_value, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(id, org.id, name, strategy, JSON.stringify(team), cleanText(body.language, 10) || null, cleanText(body.product_category, 60) || null,
        body.min_deal_value != null && Number.isFinite(Number(body.min_deal_value)) ? Number(body.min_deal_value) : null, nowIso());
      return ctx.sendJSON(201, { id, message: "Règle d'assignation créée." });
    }
  }
  const ruleId = path.match(/^\/api\/assignment-rules\/([0-9a-f-]+)$/i);
  if (ruleId) {
    if (method === "PUT") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const r = isUuid(ruleId[1]) ? db.prepare("SELECT * FROM assignment_rules WHERE id = ? AND organization_id = ?").get(ruleId[1], org.id) : null;
      if (!r) return ctx.sendJSON(404, { error: "Règle introuvable." });
      db.prepare("UPDATE assignment_rules SET active = ?, strategy = ? WHERE id = ?")
        .run(body.active === false ? 0 : 1, ASSIGN_STRATEGIES.includes(body.strategy) ? body.strategy : r.strategy, r.id);
      return ctx.sendJSON(200, { message: "Règle mise à jour." });
    }
    if (method === "DELETE") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      db.prepare("DELETE FROM assignment_rules WHERE id = ? AND organization_id = ?").run(ruleId[1], org.id);
      return ctx.sendJSON(200, { message: "Règle supprimée." });
    }
  }

  /* ---------- Prédiction (spec §35-40, §55) ---------- */
  if (path === "/api/predictions/readiness" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    return ctx.sendJSON(200, predictionReadiness(db, db.prepare("SELECT * FROM organizations WHERE id = ?").get(org.id)));
  }
  const predLead = path.match(/^\/api\/predictions\/([0-9a-f-]+)$/i);
  if (predLead && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const lead = isUuid(predLead[1]) ? db.prepare("SELECT * FROM leads WHERE id = ? AND organization_id = ?").get(predLead[1], org.id) : null;
    if (!lead) return ctx.sendJSON(404, { error: "Lead introuvable." });
    const provider = getPredictionProvider(db, org.id);
    const events = db.prepare("SELECT * FROM sales_prediction_events WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 20").all(org.id, lead.id)
      .map((e) => ({ ...e, features_snapshot: safeParse(e.features_snapshot, {}) }));
    return ctx.sendJSON(200, {
      lead: { id: lead.id, name: lead.name, score: lead.score, purchase_intent: lead.purchase_intent },
      provider, // { mode: HEURISTIC|ML, label: "HEURISTIC ESTIMATE" | "ML PREDICTION" }
      predictions: events,
    });
  }

  /* ---------- Analytics (spec §33-34, §46) ---------- */
  if (path === "/api/automation/analytics" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const a = computeAnalytics(db, org.id);
    // Si aucune donnée : afficher « Données insuffisantes » (jamais de statistique inventée)
    const hasData = a.automations.executions > 0 || a.messages.total > 0 || a.sequences.length > 0;
    return ctx.sendJSON(200, { ...a, has_data: hasData, note: hasData ? null : "Données insuffisantes." });
  }

  /* ---------- Journal des événements (lecture admin) ---------- */
  if (path === "/api/automation/events" && method === "GET") {
    if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
    const type = EVENT_TYPES.includes(ctx.query.type) ? ctx.query.type : null;
    const leadId = isUuid(ctx.query.lead_id) ? ctx.query.lead_id : null;
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 100, 1), 500);
    const w = ["organization_id = ?"], args = [org.id];
    if (type) { w.push("type = ?"); args.push(type); }
    if (leadId) { w.push("lead_id = ?"); args.push(leadId); }
    const events = db.prepare(`SELECT * FROM sales_events WHERE ${w.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limit);
    return ctx.sendJSON(200, { events: events.map((e) => ({ ...e, payload: safeParse(e.payload, null) })), EVENT_TYPES });
  }

  /* ---------- A/B testing : fondation (spec §47) ---------- */
  if (path === "/api/experiments") {
    if (method === "GET") {
      if (!read) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:read)." });
      const rows = db.prepare("SELECT * FROM experiments WHERE organization_id = ? ORDER BY created_at DESC").all(org.id);
      return ctx.sendJSON(200, {
        experiments: rows.map((x) => ({ ...x, variants: db.prepare("SELECT * FROM experiment_variants WHERE experiment_id = ?").all(x.id) })),
      });
    }
    if (method === "POST") {
      if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
      const name = cleanText(body.name, 120);
      if (!name) return ctx.sendJSON(400, { error: "Nom requis." });
      const metric = ["reply_rate", "qualification_rate", "conversion"].includes(body.metric) ? body.metric : "reply_rate";
      const id = randomUUID();
      const now = nowIso();
      db.prepare("INSERT INTO experiments (id, organization_id, name, metric, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?)").run(id, org.id, name, metric, now, now);
      return ctx.sendJSON(201, { id, message: "Expérience créée (brouillon) — lancement manuel requis (aucun lancement auto sur faibles volumes)." });
    }
  }
  const expId = path.match(/^\/api\/experiments\/([0-9a-f-]+)\/variants$/i);
  if (expId && method === "POST") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    const x = isUuid(expId[1]) ? db.prepare("SELECT * FROM experiments WHERE id = ? AND organization_id = ?").get(expId[1], org.id) : null;
    if (!x) return ctx.sendJSON(404, { error: "Expérience introuvable." });
    const name = cleanText(body.name, 60);
    if (!name) return ctx.sendJSON(400, { error: "Nom du variant requis." });
    const vid = randomUUID();
    db.prepare("INSERT INTO experiment_variants (id, organization_id, experiment_id, name, template_id) VALUES (?, ?, ?, ?, ?)")
      .run(vid, org.id, x.id, name, isUuid(body.template_id) ? body.template_id : null);
    return ctx.sendJSON(201, { id: vid, message: "Variant ajouté." });
  }
  const expStatus = path.match(/^\/api\/experiments\/([0-9a-f-]+)\/(start|complete)$/i);
  if (expStatus && method === "POST") {
    if (!manage) return ctx.sendJSON(403, { error: "Permission insuffisante (automation:manage)." });
    const x = isUuid(expStatus[1]) ? db.prepare("SELECT * FROM experiments WHERE id = ? AND organization_id = ?").get(expStatus[1], org.id) : null;
    if (!x) return ctx.sendJSON(404, { error: "Expérience introuvable." });
    const to = expStatus[2] === "start" ? "RUNNING" : "COMPLETED";
    db.prepare("UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?").run(to, nowIso(), x.id);
    return ctx.sendJSON(200, { message: to === "RUNNING" ? "Expérience lancée (manuellement)." : "Expérience terminée.", status: to });
  }

  /* ---------- Tick du planificateur (mode TEST uniquement — §50) ---------- */
  if (path === "/api/automation/tick" && method === "POST") {
    if (process.env.APP_ENV !== "test") return ctx.sendJSON(404, { error: "Route introuvable." });
    const stats = await tick(db);
    return ctx.sendJSON(200, { message: "Tick exécuté.", ...stats });
  }

  return false;
}

/* ---------- validation ---------- */
function validateAutomation(body) {
  const name = cleanText(body.name, 120);
  if (!name) return { error: "Nom requis." };
  if (!EVENT_TYPES.includes(body.trigger)) return { error: `Trigger invalide. Valeurs : ${EVENT_TYPES.join(", ")}.` };
  let conditions = Array.isArray(body.conditions) ? body.conditions : [];
  for (const c of conditions) {
    if (!CONDITIONS_FIELDS.includes(c.field)) return { error: `Champ de condition inconnu : ${c.field}` };
    if (!OPERATORS.includes(c.operator)) return { error: `Opérateur invalide : ${c.operator}` };
    if (c.value === undefined || c.value === null || (typeof c.value === "string" && !c.value.trim() && c.operator !== "contains")) return { error: `Valeur requise pour ${c.field}` };
  }
  let actions = Array.isArray(body.actions) ? body.actions : [];
  if (!actions.length) return { error: "Au moins une action est requise." };
  for (const a of actions) {
    if (!ACTIONS.includes(a.action)) return { error: `Action inconnue : ${a.action}` };
    if (a.delay_minutes !== undefined && (!Number.isFinite(Number(a.delay_minutes)) || Number(a.delay_minutes) <= 0 || Number(a.delay_minutes) > 24 * 60)) {
      return { error: "delay_minutes invalide (1 - 1440)." };
    }
    if (a.action === "START_SEQUENCE" && !isUuid(a.sequence_id)) return { error: "START_SEQUENCE : sequence_id requis." };
  }
  return { name, trigger: body.trigger, conditions, actions };
}

function validateSegment(def) {
  const out = {};
  if (!def || typeof def !== "object") return out;
  if (def.score_min !== undefined) { const n = Number(def.score_min); out.score_min = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
  if (Array.isArray(def.statuses)) out.statuses = def.statuses.filter((s) => ["NEW", "CONTACTED", "QUALIFIED", "HOT", "PROPOSAL", "NEGOTIATION", "WON", "LOST"].includes(s));
  if (Array.isArray(def.sources)) out.sources = def.sources.filter((s) => typeof s === "string");
  if (def.country) out.country = String(def.country).toUpperCase().slice(0, 2);
  if (def.city) out.city = String(def.city).slice(0, 60);
  if (def.product_interest) out.product_interest = String(def.product_interest).slice(0, 120);
  if (def.max_days_inactive !== undefined) { const n = Number(def.max_days_inactive); out.max_days_inactive = Number.isFinite(n) ? Math.max(1, n) : 30; }
  if (def.at_risk !== undefined) out.at_risk = !!def.at_risk;
  if (def.purchase_intent) out.purchase_intent = String(def.purchase_intent).toUpperCase().slice(0, 10);
  return out;
}

function segmentWhere(orgId, def) {
  const w = ["l.organization_id = ?"], args = [orgId];
  if (def.score_min != null) { w.push("COALESCE(l.score, 0) >= ?"); args.push(def.score_min); }
  if (def.statuses?.length) { w.push(`l.status IN (${def.statuses.map(() => "?").join(",")})`); args.push(...def.statuses); }
  if (def.sources?.length) { w.push(`l.source IN (${def.sources.map(() => "?").join(",")})`); args.push(...def.sources); }
  if (def.country) { w.push("l.country = ?"); args.push(def.country); }
  if (def.city) { w.push("l.city = ?"); args.push(def.city); }
  if (def.product_interest) { w.push("l.interest LIKE ?"); args.push(`%${def.product_interest}%`); }
  if (def.max_days_inactive != null) { w.push("COALESCE(l.last_contact_at, l.created_at) < datetime('now', ?)"); args.push(`-${def.max_days_inactive} day`); }
  if (def.at_risk) { w.push("l.at_risk = 1"); }
  if (def.purchase_intent) { w.push("l.purchase_intent = ?"); args.push(def.purchase_intent); }
  return { w, args };
}

function segmentLeads(db, orgId, def, limit) {
  const { w, args } = segmentWhere(orgId, def);
  return db.prepare(`SELECT * FROM leads l WHERE ${w.join(" AND ")} ORDER BY COALESCE(l.score, 0) DESC LIMIT ?`).all(...args, limit);
}

function segmentCount(db, orgId, def) {
  const { w, args } = segmentWhere(orgId, def);
  return db.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${w.join(" AND ")}`).get(...args).n;
}

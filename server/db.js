// server/db.js — base de données SQLite (node:sqlite, zéro dépendance)
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Chemin DB :
 *  - DB_PATH si défini
 *  - sur Vercel : /tmp (seul FS accessible en écriture)
 *  - sinon : data/sales-agent.db local
 * Au premier boot Vercel, on copie le seed démo (si présent) pour un compte prêt à tester.
 */
function resolveDbPath() {
  if (process.env.DB_PATH) return resolve(process.env.DB_PATH);
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "/tmp/sales-agent.db";
  }
  return resolve(ROOT, "data/sales-agent.db");
}

export const DB_PATH = resolveDbPath();

mkdirSync(dirname(DB_PATH), { recursive: true });

// Seed démo (TechStore) au premier démarrage serverless / Vercel uniquement.
// En local, on part d'une DB vide sauf si SEED_ON_BOOT=true.
const shouldSeed = process.env.SEED_ON_BOOT === "true"
  || !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const seedCandidates = [
  resolve(ROOT, "data/seed/demo.db"),
  resolve(ROOT, "data/demo.db"),
];
if (shouldSeed && !existsSync(DB_PATH)) {
  for (const seed of seedCandidates) {
    if (existsSync(seed)) {
      try {
        copyFileSync(seed, DB_PATH);
        console.log(`📦 DB initialisée depuis le seed : ${seed}`);
      } catch (e) {
        console.warn("seed copy failed:", e?.message || e);
      }
      break;
    }
  }
}

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  phone           TEXT,
  password_hash   TEXT NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  country                TEXT NOT NULL DEFAULT 'TG',
  industry               TEXT,
  currency               TEXT NOT NULL DEFAULT 'XOF',
  logo_url               TEXT,
  goal                   TEXT,
  onboarding_completed   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT,
  role             TEXT NOT NULL DEFAULT 'VIEWER',
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_org_user  ON organization_members(organization_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_invite    ON organization_members(organization_id, email) WHERE status = 'invited';

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding (
  organization_id  TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  step             INTEGER NOT NULL DEFAULT 0,
  industry         TEXT,
  country          TEXT,
  currency         TEXT,
  goal             TEXT,
  completed        INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  action           TEXT NOT NULL,
  resource_type    TEXT,
  resource_id      TEXT,
  metadata         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan                  TEXT NOT NULL DEFAULT 'FREE',
  status                TEXT NOT NULL DEFAULT 'active',
  current_period_start  TEXT,
  current_period_end    TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

/* ================= PHASE 2 — moteur commercial ================= */

CREATE TABLE IF NOT EXISTS categories (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_org ON categories(organization_id);

CREATE TABLE IF NOT EXISTS products (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  sku                  TEXT,
  type                 TEXT NOT NULL DEFAULT 'PRODUCT',  -- PRODUCT | SERVICE
  category_id          TEXT REFERENCES categories(id) ON DELETE SET NULL,
  description          TEXT,
  price                REAL NOT NULL DEFAULT 0,
  discount_price       REAL,
  currency             TEXT,                              -- NULL → devise de l'organisation
  stock_quantity       INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold  INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'ACTIVE',    -- ACTIVE | INACTIVE
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_org       ON products(organization_id);
CREATE INDEX IF NOT EXISTS idx_products_org_sku   ON products(organization_id, sku);
CREATE INDEX IF NOT EXISTS idx_products_org_status ON products(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_products_org_created ON products(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_products_category  ON products(category_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id           TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  sku                  TEXT,
  price                REAL,
  stock_quantity       INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold  INTEGER NOT NULL DEFAULT 0,
  attributes           TEXT,                               -- JSON
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_org     ON product_variants(organization_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS product_images (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  alt_text         TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_images_org     ON product_images(organization_id);

CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  company_name     TEXT,
  country          TEXT,
  city             TEXT,
  notes            TEXT,
  source           TEXT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | INACTIVE
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_org      ON customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_customers_org_email ON customers(organization_id, email);
CREATE INDEX IF NOT EXISTS idx_customers_org_phone ON customers(organization_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_org_status ON customers(organization_id, status);

CREATE TABLE IF NOT EXISTS leads (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id        TEXT REFERENCES customers(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  company_name       TEXT,
  email              TEXT,
  phone              TEXT,
  source             TEXT NOT NULL DEFAULT 'MANUAL',
  status             TEXT NOT NULL DEFAULT 'NEW',
  interest           TEXT,
  budget             INTEGER,
  currency           TEXT,
  score              INTEGER NOT NULL DEFAULT 0,   -- 0-100 (calcul IA = Phase 4)
  notes              TEXT,
  assigned_to        TEXT,
  last_contact_at    TEXT,
  next_followup_at   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_org         ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_org_status  ON leads(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org_assigned ON leads(organization_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_org_created ON leads(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_org_email   ON leads(organization_id, email);

CREATE TABLE IF NOT EXISTS deals (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id          TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id              TEXT REFERENCES leads(id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  description          TEXT,
  value                REAL NOT NULL DEFAULT 0,
  currency             TEXT,
  stage                TEXT NOT NULL DEFAULT 'NEW',
  probability          INTEGER NOT NULL DEFAULT 50,
  expected_close_date  TEXT,
  assigned_to          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deals_org          ON deals(organization_id);
CREATE INDEX IF NOT EXISTS idx_deals_org_stage    ON deals(organization_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_org_assigned ON deals(organization_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_deals_org_created  ON deals(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deals_lead         ON deals(lead_id);

CREATE TABLE IF NOT EXISTS deal_products (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id          TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity         INTEGER NOT NULL DEFAULT 1,
  unit_price       REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deal_products_deal   ON deal_products(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_products_org    ON deal_products(organization_id);
CREATE INDEX IF NOT EXISTS idx_deal_products_product ON deal_products(product_id);

CREATE TABLE IF NOT EXISTS activities (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id          REFERENCES deals(id) ON DELETE SET NULL,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  type             TEXT NOT NULL,
  description      TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_org      ON activities(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id);
CREATE INDEX IF NOT EXISTS idx_activities_lead     ON activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal     ON activities(deal_id);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assigned_to      TEXT,
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          REFERENCES leads(id) ON DELETE SET NULL,
  deal_id          REFERENCES deals(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  priority         TEXT NOT NULL DEFAULT 'MEDIUM',  -- LOW | MEDIUM | HIGH | URGENT
  status           TEXT NOT NULL DEFAULT 'TODO',    -- TODO | IN_PROGRESS | COMPLETED | CANCELLED
  due_date         TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_org          ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status   ON tasks(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_org_assigned ON tasks(organization_id, assigned_to);

CREATE TABLE IF NOT EXISTS notes (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          REFERENCES leads(id) ON DELETE SET NULL,
  deal_id          TEXT REFERENCES deals(id) ON DELETE SET NULL,
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_org    ON notes(organization_id);
CREATE INDEX IF NOT EXISTS idx_notes_customer ON notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_notes_lead   ON notes(lead_id);
CREATE INDEX IF NOT EXISTS idx_notes_deal   ON notes(deal_id);

/* ================= PHASE 3 — moteur IA ================= */

CREATE TABLE IF NOT EXISTS agent_settings (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL DEFAULT 'AI Sales Agent',
  description           TEXT,
  language              TEXT NOT NULL DEFAULT 'fr',      -- fr | en (ewe, kabye… à venir)
  tone                  TEXT NOT NULL DEFAULT 'professional', -- professional | friendly | direct | premium | consultative
  style                 TEXT NOT NULL DEFAULT 'equilibre',    -- court | equilibre | detaille
  personality           TEXT,
  business_goal         TEXT,
  welcome_message       TEXT,
  fallback_message      TEXT,
  human_handoff_enabled INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | ACTIVE | PAUSED
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL,
  version          INTEGER NOT NULL,
  instructions     TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_org ON agent_prompt_versions(organization_id, active);

CREATE TABLE IF NOT EXISTS sales_rules (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  max_discount_percent REAL NOT NULL DEFAULT 0,
  negotiation_enabled  INTEGER NOT NULL DEFAULT 0,
  minimum_order_value  REAL,
  payment_methods      TEXT,
  delivery_information TEXT,
  return_policy        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'TEXT',  -- TEXT | FAQ | POLICY | CONDITIONS | DELIVERY | RETURN | WARRANTY | COMPANY
  source           TEXT,
  status           TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING | READY | FAILED
  content          TEXT NOT NULL,
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_org ON knowledge_documents(organization_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id      TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  content          TEXT NOT NULL,
  chunk_index      INTEGER NOT NULL DEFAULT 0,
  embedding        TEXT,  -- vecteur sparse JSON (local) — architecture prête pour pgvector
  metadata         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_org ON knowledge_chunks(organization_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON knowledge_chunks(document_id);

CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          REFERENCES leads(id) ON DELETE SET NULL,
  agent_id         TEXT,
  channel          TEXT NOT NULL DEFAULT 'WEBSITE_TEST',
  status           TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | RESOLVED | HANDOFF
  metadata         TEXT,  -- contexte de session (budget, produit, résumé conversation)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_org ON conversations(organization_id);
CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conv_lead ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(organization_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,  -- USER | ASSISTANT | SYSTEM | TOOL
  content          TEXT NOT NULL,
  metadata         TEXT,  -- intent, confidence, tokens, model, tool_calls, products, lead_score, sources
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  conversation_id  TEXT,
  model            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  estimated_cost   REAL NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  response_ms      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org ON ai_usage(organization_id, created_at);

/* ================= PHASE 4 — Smart Sales Engine ================= */

CREATE TABLE IF NOT EXISTS lead_score_history (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  score            INTEGER NOT NULL,
  previous_score   INTEGER,
  change           INTEGER,
  reason           TEXT,
  source           TEXT NOT NULL DEFAULT 'smart_engine',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score_history_lead ON lead_score_history(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_history_org ON lead_score_history(organization_id);

CREATE TABLE IF NOT EXISTS objections (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id          TEXT REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,   -- PRICE | TRUST | QUALITY | DELIVERY | PAYMENT | FEATURES | COMPETITOR | TIMING | NEED | OTHER
  text             TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'MEDIUM', -- LOW | MEDIUM | HIGH | CRITICAL
  resolved         INTEGER NOT NULL DEFAULT 0,
  metadata         TEXT,            -- JSON (competitor_name, confidence…)
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objections_lead ON objections(lead_id);
CREATE INDEX IF NOT EXISTS idx_objections_org ON objections(organization_id);

CREATE TABLE IF NOT EXISTS buying_signals (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id          TEXT REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,   -- PURCHASE | PAYMENT_METHOD | DELIVERY_AREA | DELIVERY_COST | AVAILABILITY | ORDER_TODAY | TAKE_PRODUCT
  confidence       INTEGER NOT NULL DEFAULT 90,
  text             TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buying_signals_lead ON buying_signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_buying_signals_org ON buying_signals(organization_id);

/* ================= PHASE 5 — Automation Engine + Follow-up + Séquences ================= */

CREATE TABLE IF NOT EXISTS sales_events (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,   -- LEAD_CREATED | LEAD_BECAME_HOT | PURCHASE_INTENT_DETECTED | ...
  entity_type      TEXT,            -- lead | deal | conversation | customer | task
  entity_id        TEXT,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  conversation_id  TEXT,
  payload          TEXT,            -- JSON (données d'événement)
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_org ON sales_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_lead ON sales_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON sales_events(organization_id, type);

CREATE TABLE IF NOT EXISTS automations (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | ACTIVE | PAUSED | ARCHIVED
  trigger          TEXT NOT NULL,                  -- type d'événement (LEAD_BECAME_HOT, ...)
  conditions       TEXT NOT NULL DEFAULT '[]',     -- JSON [{field, operator, value}]
  actions          TEXT NOT NULL DEFAULT '[]',     -- JSON [{action, ...params, delay_minutes?}]
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_org ON automations(organization_id, status);

CREATE TABLE IF NOT EXISTS automation_logs (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id    TEXT REFERENCES automations(id) ON DELETE SET NULL,
  event_id         TEXT,
  trigger          TEXT,
  conditions       TEXT,                 -- JSON (évaluation)
  action           TEXT,
  status           TEXT NOT NULL,        -- SUCCESS | FAILED | SKIPPED | CANCELLED
  error            TEXT,
  idempotency_key  TEXT,                 -- automation_id + lead_id + event_id + action
  execution_time   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_logs_idem ON automation_logs(organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_auto_logs_org ON automation_logs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
  id               TEXT PRIMARY KEY,     -- exécutions différées (attendre N min → re-vérifier → agir)
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id    TEXT REFERENCES automations(id) ON DELETE SET NULL,
  event_id         TEXT,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  action           TEXT NOT NULL,        -- JSON de l'action à exécuter
  due_at           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | DONE | CANCELLED
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_runs_due ON automation_runs(status, due_at);

CREATE TABLE IF NOT EXISTS communication_limits (
  organization_id  TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  max_per_day      INTEGER NOT NULL DEFAULT 2,
  max_per_week     INTEGER NOT NULL DEFAULT 5,
  min_interval_minutes INTEGER NOT NULL DEFAULT 60,
  max_followups    INTEGER NOT NULL DEFAULT 4
);

CREATE TABLE IF NOT EXISTS communication_preferences (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id      TEXT REFERENCES customers(id) ON DELETE CASCADE,
  lead_id          TEXT REFERENCES leads(id) ON DELETE CASCADE,
  email            INTEGER NOT NULL DEFAULT 1,
  sms              INTEGER NOT NULL DEFAULT 1,
  whatsapp         INTEGER NOT NULL DEFAULT 1,
  marketing        INTEGER NOT NULL DEFAULT 1,
  transactional    INTEGER NOT NULL DEFAULT 1,
  opted_out_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_prefs_lead ON communication_preferences(lead_id);
CREATE INDEX IF NOT EXISTS idx_comm_prefs_customer ON communication_preferences(customer_id);

CREATE TABLE IF NOT EXISTS message_templates (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'EMAIL',  -- EMAIL | SMS | WHATSAPP | WEBCHAT | INSTAGRAM | FACEBOOK
  subject          TEXT,
  content          TEXT NOT NULL,                  -- variables {{first_name}} {{product_name}} {{company_name}} {{deal_value}} {{sales_agent}}
  language         TEXT NOT NULL DEFAULT 'fr',
  status           TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ARCHIVED
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_org ON message_templates(organization_id);

CREATE TABLE IF NOT EXISTS sequences (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | ACTIVE | PAUSED | ARCHIVED
  channel          TEXT NOT NULL DEFAULT 'WEBCHAT',
  steps            TEXT NOT NULL DEFAULT '[]',     -- JSON [{wait, subject, content, template_id?}]
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sequences_org ON sequences(organization_id, status);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sequence_id      TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  lead_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | COMPLETED | STOPPED
  current_step     INTEGER NOT NULL DEFAULT 0,
  next_run_at      TEXT,
  stop_reason      TEXT,
  enrolled_at      TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seq_enroll_due ON sequence_enrollments(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_seq_enroll_lead ON sequence_enrollments(lead_id);

CREATE TABLE IF NOT EXISTS followup_history (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id      TEXT,
  campaign_id      TEXT,
  step             INTEGER,
  channel          TEXT NOT NULL DEFAULT 'WEBCHAT',
  subject          TEXT,
  message          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED | PENDING_APPROVAL | DRAFTED | SENT | FAILED | CANCELLED
  attempts         INTEGER NOT NULL DEFAULT 0,
  scheduled_at     TEXT,
  sent_at          TEXT,
  response_at      TEXT,
  cancel_reason    TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followup_due ON followup_history(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_followup_lead ON followup_history(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_followup_org ON followup_history(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assignment_rules (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  strategy         TEXT NOT NULL DEFAULT 'ROUND_ROBIN', -- ROUND_ROBIN | TERRITORY | LANGUAGE | PRODUCT | WORKLOAD
  team_member_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON (users)
  language         TEXT,
  product_category TEXT,
  min_deal_value   INTEGER,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  type             TEXT NOT NULL,   -- HOT_LEAD | URGENT_LEAD | HIGH_VALUE_DEAL | DEAL_AT_RISK | HUMAN_HANDOFF | COMPLAINT | PURCHASE_INTENT | FOLLOWUP_APPROVAL | AUTOMATION_FAILED
  title            TEXT NOT NULL,
  message          TEXT,
  link             TEXT,
  lead_id          TEXT,
  read             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS segments (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  definition       TEXT NOT NULL DEFAULT '{}',  -- JSON {score_min, statuses[], sources[], country, city, product_interest, max_days_inactive, at_risk, purchase_intent}
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | ACTIVE | COMPLETED | PAUSED
  segment_id       TEXT REFERENCES segments(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL DEFAULT 'WEBCHAT',
  template_id      TEXT REFERENCES message_templates(id) ON DELETE SET NULL,
  max_recipients   INTEGER NOT NULL DEFAULT 500,
  recipients_count INTEGER NOT NULL DEFAULT 0,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT
);

CREATE TABLE IF NOT EXISTS sales_prediction_events (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  prediction_type  TEXT NOT NULL DEFAULT 'CONVERSION',  -- CONVERSION | CHURN | HOT_LEAD
  prediction_value REAL,
  prediction_confidence INTEGER,
  features_snapshot TEXT NOT NULL,      -- JSON : état des données AU MOMENT de la prédiction (immuable)
  actual_outcome   TEXT,                -- UNKNOWN | WON | LOST
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_prediction_lead ON sales_prediction_events(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_org ON sales_prediction_events(organization_id, actual_outcome);

CREATE TABLE IF NOT EXISTS prediction_models (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_type       TEXT NOT NULL,       -- CONVERSION | CHURN | HOT_LEAD
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'EXPERIMENTAL', -- EXPERIMENTAL | ACTIVE | RETIRED
  metrics          TEXT,                -- JSON {precision, recall, f1, roc_auc, pr_auc, calibration, confusion_matrix, baseline_heuristic}
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  metric           TEXT NOT NULL DEFAULT 'reply_rate',  -- reply_rate | qualification_rate | conversion
  status           TEXT NOT NULL DEFAULT 'DRAFT',       -- DRAFT | RUNNING | COMPLETED
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id    TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  template_id      TEXT,
  assigned_count   INTEGER NOT NULL DEFAULT 0,
  replies          INTEGER NOT NULL DEFAULT 0,
  conversions      INTEGER NOT NULL DEFAULT 0
);

/* ================= PHASE 6 — Canaux officiels (WhatsApp / Messenger / Instagram / Email) ================= */

CREATE TABLE IF NOT EXISTS channel_connections (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel          TEXT NOT NULL,    -- WHATSAPP | FACEBOOK_MESSENGER | INSTAGRAM | EMAIL
  status           TEXT NOT NULL DEFAULT 'DISCONNECTED',  -- DISCONNECTED | CONNECTED | ERROR
  config           TEXT,             -- JSON (tokens/identifiants — JAMAIS retournés en clair par l'API)
  display_name     TEXT,
  last_error       TEXT,
  last_checked_at  TEXT,
  connected_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (organization_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_channel_conn_org ON channel_connections(organization_id);

CREATE TABLE IF NOT EXISTS channel_messages (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id    TEXT REFERENCES channel_connections(id) ON DELETE SET NULL,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  followup_id      TEXT,
  channel          TEXT NOT NULL,
  direction        TEXT NOT NULL,    -- IN | OUT
  to_address       TEXT,
  from_address     TEXT,
  content          TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | DELIVERED | READ | FAILED | BOUNCED
  provider_message_id TEXT,          -- ID fournisseur (idempotence des entrantes)
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_msg_provider ON channel_messages(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_channel_msg_org ON channel_messages(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_msg_lead ON channel_messages(lead_id, created_at DESC);

/* ================= PHASE 6 — Omnicanal : webhooks (anti-replay) + inbox ================= */

-- Anti-replay / anti-doublon des webhooks (spec Phase 6 « Webhooks »).
-- Chaque événement fournisseur est journalisé une seule fois : provider + event_id
-- est UNIQUE ; la signature + timestamp sont conservés pour rejeter les replays.
CREATE TABLE IF NOT EXISTS webhook_events (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL,       -- WHATSAPP | FACEBOOK_MESSENGER | INSTAGRAM | EMAIL | SMS | WEBCHAT
  provider         TEXT NOT NULL,       -- META | TWILIO | GMAIL | ...
  event_id         TEXT NOT NULL,       -- ID événement fournisseur (wamid, mid, Message-ID, SID)
  signature        TEXT,
  signature_ok     INTEGER NOT NULL DEFAULT 0,
  received_at      TEXT NOT NULL,
  processed_at     TEXT,
  status           TEXT NOT NULL DEFAULT 'RECEIVED',  -- RECEIVED | PROCESSED | DUPLICATE | REPLAY | ERROR
  payload_hash     TEXT,
  UNIQUE (channel, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_org ON webhook_events(organization_id, received_at DESC);

-- Mode HYBRID : réponses suggérées par l'IA, approuvées/rejetées par l'humain (spec Phase 6).
CREATE TABLE IF NOT EXISTS suggested_replies (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       TEXT,
  content          TEXT NOT NULL,
  rationale        TEXT,
  confidence       INTEGER,
  status           TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED | SENT | EXPIRED
  created_by       TEXT NOT NULL DEFAULT 'ai',
  reviewed_by      TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggested_replies_conv ON suggested_replies(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_suggested_replies_org ON suggested_replies(organization_id, status);

/* ================= PHASE 7 — Devis (quotes) + Commandes (orders) + Paiements ================= */

-- Devis professionnels (spec §21) : DRAFT → SENT → VIEWED → ACCEPTED / REJECTED / EXPIRED.
-- access_token : lien d'acceptation public (le client n'a PAS besoin de compte) —
-- ce n'est JAMAIS l'ID interne ; aucune donnée sensible n'est exposée via ce lien.
CREATE TABLE IF NOT EXISTS quotes (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,             -- DEV-YYYY-NNNN (séquentiel par org)
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  deal_id          TEXT REFERENCES deals(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | SENT | VIEWED | ACCEPTED | REJECTED | EXPIRED | CANCELLED
  currency         TEXT,                       -- NULL = devise de l'organisation
  subtotal         REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  tax              REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  valid_until      TEXT,                       -- expiration (si NULL : 30 jours par défaut à l'envoi)
  notes            TEXT,
  access_token     TEXT NOT NULL,              -- lien public /quote/<token>
  sent_at          TEXT,
  viewed_at        TEXT,
  decided_at       TEXT,
  decision_reason  TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (organization_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_token ON quotes(access_token);
CREATE INDEX IF NOT EXISTS idx_quotes_org ON quotes(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_org_num ON quotes(organization_id, number);

-- Lignes de devis (jamais de prix client : pris du catalogue à la création)
CREATE TABLE IF NOT EXISTS quote_items (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quote_id         TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id       TEXT REFERENCES products(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1,
  unit_price       REAL NOT NULL DEFAULT 0,
  discount         REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0    -- qty × unit_price − discount (borné ≥ 0)
);
CREATE INDEX IF NOT EXISTS idx_qi_quote ON quote_items(quote_id);

-- Commandes (spec §22) : QUOTE ACCEPTED → ORDER → PAYMENT → PROCESSING → COMPLETED
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,             -- CMD-YYYY-NNNN
  quote_id         TEXT REFERENCES quotes(id) ON DELETE SET NULL,
  deal_id          TEXT REFERENCES deals(id) ON DELETE SET NULL,
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | CONFIRMED | PAID | PROCESSING | COMPLETED | CANCELLED | REFUNDED
  currency         TEXT,
  total            REAL NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  paid_at          TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (organization_id, number)
);
CREATE INDEX IF NOT EXISTS idx_orders_org ON orders(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders(quote_id);

-- Paiements (spec §23) — JAMAIS simulés : un paiement est CONFIRMED uniquement
-- après vérification RÉELLE par le fournisseur (webhook signé / callback).
-- provider : CARD | MOBILE_MONEY | BANK_TRANSFER (production, configuration
-- requise) | TEST (double de test, UNIQUEMENT en APP_ENV=test).
CREATE TABLE IF NOT EXISTS payments (
  id                        TEXT PRIMARY KEY,
  organization_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id                  TEXT REFERENCES orders(id) ON DELETE CASCADE,
  invoice_id                TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  provider                  TEXT NOT NULL,
  provider_transaction_id   TEXT,             -- ID transaction côté fournisseur
  method                    TEXT,             -- carte / mobile money (numéro masqué) / virement
  amount                    REAL NOT NULL,
  currency                  TEXT,
  status                    TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | CONFIRMED | FAILED | REFUNDED | CANCELLED
  provider_payload          TEXT,             -- instructions fournisseur (JAMAIS de données carte)
  error                     TEXT,
  created_at                TEXT NOT NULL,
  confirmed_at              TEXT,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_org ON payments(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payments(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_provider_tx ON payments(provider, provider_transaction_id);

/* ================= PHASE 8 — SaaS : plans, trial, facturation ================= */

-- Définitions des plans (prix + limites) — configurables côté super-admin
-- (spec §7 : « Les prix doivent être configurables depuis le panneau
-- administrateur. Chaque plan peut avoir : users, leads, AI messages, … »).
-- limits : JSON { users, leads, ai_messages (mois), conversations (mois),
--                automations, channels, kb_documents, storage_mb }
--   -1 = illimité. features : JSON [libellés d'affichage].
CREATE TABLE IF NOT EXISTS plan_definitions (
  code           TEXT PRIMARY KEY,     -- FREE | STARTER | PRO | BUSINESS | ENTERPRISE (ou personnalisé)
  name           TEXT NOT NULL,
  price_monthly  REAL NOT NULL DEFAULT 0,
  price_annual   REAL NOT NULL DEFAULT 0,  -- 0 = pas d'offre annuelle
  currency       TEXT NOT NULL DEFAULT 'USD',
  limits         TEXT NOT NULL,        -- JSON (voir ci-dessus)
  features       TEXT NOT NULL,        -- JSON
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

-- Factures de SaaS (spécifique à la facturation — la table payments couvre
-- aussi les commandes ; une invoice = une période de plan à payer).
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number          TEXT NOT NULL,       -- INV-YYYY-NNNN (séquentiel par org)
  plan            TEXT,
  period_start    TEXT,
  period_end      TEXT,
  amount          REAL NOT NULL,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | PAID | VOID
  payment_id      TEXT,                       -- paiement lié (CONFIRMÉ pour PAID)
  due_at          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (organization_id, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(organization_id, created_at DESC);
`);

// ---- Seed des plans (valeurs par défaut ; modifiables par le super-admin) ----
const PLAN_SEED = [
  { code: "FREE", name: "Gratuit", price_monthly: 0, price_annual: 0, currency: "USD",
    limits: { users: 3, leads: 100, ai_messages: 50, conversations: 200, automations: 5, channels: 1, kb_documents: 10, storage_mb: 100 },
    features: ["1 agent IA", "100 leads", "50 messages IA / mois", "1 canal", "Knowledge base (10 documents)"], sort_order: 1 },
  { code: "STARTER", name: "Starter", price_monthly: 29, price_annual: 290, currency: "USD",
    limits: { users: 5, leads: 1000, ai_messages: 500, conversations: 2000, automations: 20, channels: 2, kb_documents: 50, storage_mb: 500 },
    features: ["1 agent IA", "1 000 leads", "500 messages IA / mois", "2 canaux", "Knowledge base (50 documents)", "Automations (20)"], sort_order: 2 },
  { code: "PRO", name: "Pro", price_monthly: 79, price_annual: 790, currency: "USD",
    limits: { users: 15, leads: 10000, ai_messages: 20000, conversations: 20000, automations: 100, channels: 4, kb_documents: 200, storage_mb: 2048 },
    features: ["1 agent IA", "10 000 leads", "20 000 messages IA / mois", "4 canaux", "Knowledge base (200 documents)", "Automations (100)", "Rôles & permissions"], sort_order: 3 },
  { code: "BUSINESS", name: "Business", price_monthly: 199, price_annual: 1990, currency: "USD",
    limits: { users: 50, leads: 100000, ai_messages: 5000, conversations: 100000, automations: 500, channels: 6, kb_documents: 1000, storage_mb: 10240 },
    features: ["1 agent IA", "100 000 leads", "5 000 messages IA / mois", "6 canaux", "Knowledge base (1 000 documents)", "Support prioritaire"], sort_order: 4 },
  { code: "ENTERPRISE", name: "Entreprise", price_monthly: 0, price_annual: 0, currency: "USD",
    limits: { users: -1, leads: -1, ai_messages: -1, conversations: -1, automations: -1, channels: -1, kb_documents: -1, storage_mb: -1 },
    features: ["Tout illimité", "SLA dédié", "SSO & sécurité avancée", "Account manager dédié"], sort_order: 5 },
];
const planDefCount = db.prepare("SELECT COUNT(*) n FROM plan_definitions").get().n;
if (planDefCount === 0) {
  const ins = db.prepare(
    `INSERT INTO plan_definitions (code, name, price_monthly, price_annual, currency, limits, features, active, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const t = new Date().toISOString();
  for (const p of PLAN_SEED) ins.run(p.code, p.name, p.price_monthly, p.price_annual, p.currency, JSON.stringify(p.limits), JSON.stringify(p.features), p.sort_order, t);
}

// Migration douce : colonnes Phase 4 ajoutées à la table leads existante (Phase 2)
const leadsCols = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
const leadsAddCols = [
  "purchase_intent TEXT",                       // VERY_LOW | LOW | MEDIUM | HIGH | VERY_HIGH
  "conversion_probability INTEGER",            // 0-100 (estimation heuristique)
  "bant_budget TEXT DEFAULT 'UNKNOWN'",        // UNKNOWN | LOW | MEDIUM | HIGH | CONFIRMED
  "bant_authority TEXT DEFAULT 'UNKNOWN'",
  "bant_need TEXT DEFAULT 'UNKNOWN'",
  "bant_timeline TEXT DEFAULT 'UNKNOWN'",
  "priority TEXT DEFAULT 'LOW'",               // LOW | MEDIUM | HIGH | URGENT
  "hot INTEGER NOT NULL DEFAULT 0",
  "at_risk INTEGER NOT NULL DEFAULT 0",
  "estimated_value INTEGER",                   // jamais inventée : deal.value ou prix catalogue
  "next_best_action TEXT",
  "next_best_action_reason TEXT",
  "follow_up_message TEXT",
  "conversation_id TEXT",                      // conversation principale du lead
];
for (const col of leadsAddCols) {
  if (!leadsCols.includes(col.split(" ")[0])) {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_hot ON leads(organization_id, hot)");
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_at_risk ON leads(organization_id, at_risk)");
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(organization_id, priority)");

// Migration douce : colonnes ajoutées après le schéma initial
const orgCols = db.prepare("PRAGMA table_info(organizations)").all().map((c) => c.name);
if (!orgCols.includes("settings")) {
  db.exec("ALTER TABLE organizations ADD COLUMN settings TEXT");
}

/* ================= PHASE 5 — migrations douces ================= */
// Timezone de l'organisation (ne jamais supposer UTC — spec §26)
export const COUNTRY_TIMEZONES = { TG: "Africa/Lome", BF: "Africa/Ouagadougou", CI: "Africa/Abidjan", SN: "Africa/Dakar", ML: "Africa/Bamako", BJ: "Africa/Porto-Novo", NE: "Africa/Niamey", GA: "Africa/Libreville", CM: "Africa/Douala", FR: "Europe/Paris", BE: "Europe/Brussels", CH: "Europe/Zurich", MA: "Africa/Casablanca", TN: "Africa/Tunis", DZ: "Africa/Algiers" };
if (!orgCols.includes("timezone")) {
  db.exec("ALTER TABLE organizations ADD COLUMN timezone TEXT");
  // Valeur par défaut dérivée du pays (Togo → Africa/Lome), sinon Africa/Lome
  for (const o of db.prepare("SELECT id, country FROM organizations").all()) {
    const tz = COUNTRY_TIMEZONES[o.country] || "Africa/Lome";
    db.prepare("UPDATE organizations SET timezone = ? WHERE id = ? AND (timezone IS NULL OR timezone = '')").run(tz, o.id);
  }
}
// Raison de la prochaine relance (spec §18)
const leadsCols5 = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
if (!leadsCols5.includes("followup_reason")) {
  db.exec("ALTER TABLE leads ADD COLUMN followup_reason TEXT");
}

/* ================= PHASE 6 — migrations douces ================= */
// Canal préféré du lead pour les relances (spec Phase 6 §4)
if (!leadsCols5.includes("preferred_channel")) {
  db.exec("ALTER TABLE leads ADD COLUMN preferred_channel TEXT"); // WHATSAPP | EMAIL | FACEBOOK_MESSENGER | INSTAGRAM | WEBCHAT
}
// Clé publique du widget webchat (spec Phase 6 « Webchat widget ») : identifiant
// court destiné à l'URL d'intégration — jamais un secret (le widget n'expose
// aucun token, aucun webhook_secret).
const orgCols6 = db.prepare("PRAGMA table_info(organizations)").all().map((c) => c.name);
if (!orgCols6.includes("widget_key")) {
  db.exec("ALTER TABLE organizations ADD COLUMN widget_key TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_org_widget_key ON organizations(widget_key)");
// Mode de traitement par défaut de l'org (spec Phase 6 « Handling modes ») :
// AI (auto-réponse IA) | HUMAN (IA ne répond jamais) | HYBRID (réponse suggérée à approuver).
const agentCols6 = db.prepare("PRAGMA table_info(agent_settings)").all().map((c) => c.name);
if (!agentCols6.includes("ai_handling_mode")) {
  db.exec("ALTER TABLE agent_settings ADD COLUMN ai_handling_mode TEXT NOT NULL DEFAULT 'AI'");
}
// Identifiants plateforme des clients (PSID Messenger, UID Instagram) — JSON
const custCols6 = db.prepare("PRAGMA table_info(customers)").all().map((c) => c.name);
if (!custCols6.includes("platform_ids")) {
  db.exec("ALTER TABLE customers ADD COLUMN platform_ids TEXT");   // JSON {"facebook":"...","instagram":"..."}
}

/* ================= PHASE 6 — Omnicanal : migrations douces (conversations / messages / canaux) ================= */
const convCols6 = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
const convAddCols6 = [
  "channel_conversation_id TEXT",      // ID de conversation côté fournisseur (WhatsApp conversation, Gmail thread, PSID thread…)
  "external_contact_id TEXT",          // identifiant contact côté fournisseur (waid, PSID, e-mail)
  "assigned_to TEXT",                  // agent humain assigné (inbox)
  "handling_mode TEXT NOT NULL DEFAULT 'AI'",  // AI | HUMAN | HYBRID
  "last_message_at TEXT",
  "unread_count INTEGER NOT NULL DEFAULT 0",
  "widget_visitor_id TEXT",            // webchat : identifiant visiteur (device)
  "widget_session_id TEXT",            // webchat : identifiant de session visiteur
];
for (const col of convAddCols6) {
  if (!convCols6.includes(col.split(" ")[0])) db.exec(`ALTER TABLE conversations ADD COLUMN ${col}`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_conv_org_unread ON conversations(organization_id, unread_count)");
db.exec("CREATE INDEX IF NOT EXISTS idx_conv_org_assigned ON conversations(organization_id, assigned_to)");
db.exec("CREATE INDEX IF NOT EXISTS idx_conv_handling ON conversations(organization_id, handling_mode, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_conv_external ON conversations(organization_id, external_contact_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_conv_widget ON conversations(organization_id, widget_visitor_id, widget_session_id)");

const msgCols6 = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
const msgAddCols6 = [
  "channel TEXT",                      // WEBCHAT | EMAIL | WHATSAPP | FACEBOOK_MESSENGER | INSTAGRAM | SMS
  "direction TEXT",                    // INBOUND | OUTBOUND
  "delivery_status TEXT",              // QUEUED | SENT | DELIVERED | READ | FAILED | DELIVERED_ONLY…
  "external_message_id TEXT",          // ID fournisseur (wamid, mid, Message-ID, SID)
  "thread_id TEXT",                    // email : identifiant de thread
  "in_reply_to TEXT",                  // email : Message-ID en réponse
  "email_references TEXT",             // email : en-tête References (« references » est un mot réservé SQLite)
  "external_contact_id TEXT",
];
for (const col of msgAddCols6) {
  if (!msgCols6.includes(col.split(" ")[0])) db.exec(`ALTER TABLE messages ADD COLUMN ${col}`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(conversation_id, channel)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_ext_id ON messages(external_message_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)");

// channel_connections : provider + account_identifier + secrets chiffrés (spec Phase 6)
const connCols6 = db.prepare("PRAGMA table_info(channel_connections)").all().map((c) => c.name);
for (const col of ["provider TEXT", "account_identifier TEXT"]) {
  if (!connCols6.includes(col.split(" ")[0])) db.exec(`ALTER TABLE channel_connections ADD COLUMN ${col}`);
}

/* ================= PHASE 8 — migration payments : facturation SaaS ================= */
// order_id devient NULLABLE (paiements de facturation sans commande) +
// invoice_id (facture liée). Reconstruction de table (SQLite : contrainte
// NOT NULL non modifiable in situ).
const payCols8 = db.prepare("PRAGMA table_info(payments)").all().map((c) => c.name);
if (!payCols8.includes("invoice_id")) {
  db.exec(`
    CREATE TABLE payments_new (
      id                        TEXT PRIMARY KEY,
      organization_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      order_id                  TEXT REFERENCES orders(id) ON DELETE CASCADE,
      invoice_id                TEXT REFERENCES invoices(id) ON DELETE SET NULL,
      provider                  TEXT NOT NULL,
      provider_transaction_id   TEXT,
      method                    TEXT,
      amount                    REAL NOT NULL,
      currency                  TEXT,
      status                    TEXT NOT NULL DEFAULT 'PENDING',
      provider_payload          TEXT,
      error                     TEXT,
      created_at                TEXT NOT NULL,
      confirmed_at              TEXT,
      updated_at                TEXT NOT NULL
    );
    INSERT INTO payments_new (id, organization_id, order_id, invoice_id, provider, provider_transaction_id, method, amount, currency, status, provider_payload, error, created_at, confirmed_at, updated_at)
      SELECT id, organization_id, order_id, NULL, provider, provider_transaction_id, method, amount, currency, status, provider_payload, error, created_at, confirmed_at, updated_at FROM payments;
    DROP TABLE payments;
    ALTER TABLE payments_new RENAME TO payments;
  `);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_pay_org ON payments(organization_id, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_pay_order ON payments(order_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_pay_invoice ON payments(invoice_id)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_provider_tx ON payments(provider, provider_transaction_id)");

/* ================= PHASE 8 — migrations douces (SaaS : trial + facturation) ================= */
// subscriptions : période de trial + plan différé + annulation (spec §8-9)
const subCols8 = db.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
for (const col of [
  "trial_ends_at TEXT",     // fin du trial (statut 'trial' ; après → expired → plan FREE)
  "trial_days INTEGER",     // durée du trial accordée (jours)
  "pending_plan TEXT",      // downgrade pris en fin de période (jamais de rétroactivité)
  "cancelled_at TEXT",      // annulation : reste actif jusqu'à current_period_end
]) {
  if (!subCols8.includes(col.split(" ")[0])) db.exec(`ALTER TABLE subscriptions ADD COLUMN ${col}`);
}
// users : drapeau super-admin (spéc §25 — prix des plans configurables)
const userCols8 = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols8.includes("super_admin")) db.exec("ALTER TABLE users ADD COLUMN super_admin INTEGER NOT NULL DEFAULT 0");

export const COUNTRIES = [
  { code: "TG", name: "Togo" },
  { code: "BF", name: "Burkina Faso" },
  { code: "CI", name: "Côte d'Ivoire" },
  { code: "SN", name: "Sénégal" },
  { code: "ML", name: "Mali" },
  { code: "BJ", name: "Bénin" },
  { code: "NE", name: "Niger" },
  { code: "GA", name: "Gabon" },
  { code: "CM", name: "Cameroun" },
  { code: "CD", name: "Congo (DRC)" },
  { code: "FR", name: "France" },
  { code: "BE", name: "Belgique" },
  { code: "CH", name: "Suisse" },
  { code: "MA", name: "Maroc" },
  { code: "DZ", name: "Algérie" },
  { code: "TN", name: "Tunisie" },
];

export const CURRENCY_BY_COUNTRY = {
  TG: "XOF", BF: "XOF", CI: "XOF", SN: "XOF", ML: "XOF", BJ: "XOF", NE: "XOF",
  GA: "XAF", CM: "XAF", CD: "CDF",
  FR: "EUR", BE: "EUR", CH: "CHF", MA: "MAD", DZ: "DZD", TN: "TND",
};

export const INDUSTRIES = [
  "E-commerce", "Immobilier", "Restaurant", "Hôtel",
  "Éducation", "Automobile", "Services", "Technologie", "Autre",
];

export const GOALS = [
  "Générer des leads",
  "Augmenter les ventes",
  "Automatiser le support commercial",
  "Qualifier les prospects",
  "Automatiser WhatsApp",
];

export const PLANS = ["FREE", "STARTER", "BUSINESS", "PRO", "ENTERPRISE"];

export function slugify(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
}

export function uniqueSlug(base) {
  let slug = base;
  let i = 2;
  while (db.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

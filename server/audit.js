// server/audit.js — journal d'audit (jamais de mots de passe ni de secrets)
import { uuid, nowIso } from "./security.js";

const ACTIONS = new Set([
  "LOGIN", "LOGOUT",
  "CREATE_ORGANIZATION", "UPDATE_ORGANIZATION",
  "ADD_MEMBER", "REMOVE_MEMBER", "ROLE_CHANGE",
  "PASSWORD_CHANGE", "SESSIONS_REVOKED",
  // Phase 2 — moteur commercial
  "CREATE_PRODUCT", "UPDATE_PRODUCT", "DELETE_PRODUCT",
  "CREATE_CATEGORY", "UPDATE_CATEGORY", "DELETE_CATEGORY",
  "IMPORT_PRODUCTS", "EXPORT_PRODUCTS",
  "CREATE_CUSTOMER", "UPDATE_CUSTOMER", "DELETE_CUSTOMER",
  "CREATE_LEAD", "UPDATE_LEAD", "DELETE_LEAD",
  "ASSIGN_LEAD", "CHANGE_LEAD_STATUS",
  "CREATE_DEAL", "UPDATE_DEAL", "DELETE_DEAL",
  "CHANGE_DEAL_STAGE",
  // Phase 3 — moteur IA (jamais de secrets dans les métadonnées)
  "AI_REQUEST", "AI_RESPONSE", "AI_ERROR",
  "TOOL_CALL", "TOOL_ERROR",
  "KNOWLEDGE_SEARCH", "HUMAN_HANDOFF",
]);

export function logAudit(db, { organizationId, userId = null, action, resourceType = null, resourceId = null, metadata = null }) {
  if (!organizationId || !ACTIONS.has(action)) return null;
  const id = uuid();
  db.prepare(
    `INSERT INTO audit_logs (id, organization_id, user_id, action, resource_type, resource_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, organizationId, userId, action, resourceType, resourceId, metadata ? JSON.stringify(metadata) : null, nowIso());
  return id;
}

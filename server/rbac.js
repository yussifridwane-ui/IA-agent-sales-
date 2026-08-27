// server/rbac.js — rôles et permissions (RBAC extensible)
export const ROLES = ["OWNER", "ADMIN", "MANAGER", "SALES_AGENT", "VIEWER"];

export const ROLE_LABELS = {
  OWNER: "Propriétaire",
  ADMIN: "Administrateur",
  MANAGER: "Manager",
  SALES_AGENT: "Agent commercial",
  VIEWER: "Lecture seule",
};

const RANK = { OWNER: 5, ADMIN: 4, MANAGER: 3, SALES_AGENT: 2, VIEWER: 1 };

/*
 * Permissions initiales :
 *  - OWNER       : toutes les permissions
 *  - ADMIN       : gestion entreprise + équipe
 *  - MANAGER     : lecture/gestion commerciale
 *  - SALES_AGENT : accès aux fonctionnalités commerciales
 *  - VIEWER      : lecture uniquement
 * Ajoutez de nouvelles permissions ici ; OWNER passe automatiquement.
 */
const ROLE_PERMISSIONS = {
  ADMIN: [
    "org:update",
    "team:invite", "team:remove", "role:change",
    "audit:read",
    "settings:company", "settings:profile",
    "sales:read", "sales:write",
    "commerce:read", "analytics:read", "automation:read",
    // Phase 5 — moteur d'automatisation
    "automation:manage",
    // Phase 2 — gestion commerciale
    "catalog:read", "catalog:write",
    "crm:read", "crm:write", "crm:delete",
    "import:products", "assign:leads", "dashboard:read",
  ],
  MANAGER: [
    "settings:profile",
    "sales:read", "sales:write",
    "commerce:read", "analytics:read", "automation:read",
    // Phase 5 — moteur d'automatisation
    "automation:manage",
    // Phase 2 — gestion commerciale
    "catalog:read", "catalog:write",
    "crm:read", "crm:write", "crm:delete",
    "import:products", "assign:leads", "dashboard:read",
  ],
  SALES_AGENT: [
    "settings:profile",
    "sales:read", "sales:write",
    // Phase 2 — accès commercial (règles de possession appliquées côté serveur)
    "catalog:read", "crm:read", "crm:write", "dashboard:read",
    // Phase 5 — visibilité automatisation (lecture ; approbations via crm:write)
    "automation:read",
  ],
  VIEWER: [
    "settings:profile",
    "sales:read", "commerce:read", "analytics:read", "automation:read",
    // Phase 2 — lecture uniquement
    "catalog:read", "crm:read", "dashboard:read",
  ],
};

export function rank(role) {
  return RANK[role] || 0;
}

export function can(role, permission) {
  if (!role) return false;
  if (role === "OWNER") return true;
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

export function permissionsOf(role) {
  if (role === "OWNER") return ["*"];
  return [...(ROLE_PERMISSIONS[role] || [])];
}

/**
 * Règles de changement de rôle / suppression :
 * - on ne gère jamais soi-même,
 * - l'OWNER gère tous les autres membres ; les autres rôles n'administrent
 *   que des membres de rang strictement inférieur au leur,
 * - l'ownership n'est pas assignable (transfert explicite — phase suivante).
 */
export function canManageMember(actorRole, targetRole, actorId, targetId) {
  if (actorId && targetId && actorId === targetId) return false;
  if (actorRole === "OWNER") return true;
  return rank(actorRole) > rank(targetRole);
}

export function canAssignRole(actorRole, newRole) {
  if (!isRoleAssignable(newRole)) return false;
  if (actorRole === "OWNER") return true;
  return rank(actorRole) > rank(newRole);
}

export function isRoleAssignable(role) {
  return role !== "OWNER"; // l'ownership se transfère explicitement (phase suivante)
}

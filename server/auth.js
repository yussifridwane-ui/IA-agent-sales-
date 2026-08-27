// server/auth.js — sessions + CSRF (HMAC stateless sur l'id de session)
import crypto from "node:crypto";
import {
  uuid, sha256, nowIso,
  setSessionCookie, clearSessionCookie,
  parseCookies, isSecureRequest, clientIp,
} from "./security.js";

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours

export function createSession(db, req, res, { userId, workspaceId }) {
  const id = uuid();
  const token = crypto.randomBytes(32).toString("hex");
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, workspace_id, ip, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, userId, sha256(token), workspaceId,
    clientIp(req),
    String(req.headers["user-agent"] || "").slice(0, 300),
    created, expires
  );
  setSessionCookie(res, token, { secure: isSecureRequest(req), maxAge: SESSION_TTL_MS / 1000 });
  return { id };
}

export function destroySession(db, res, sessionId) {
  if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  clearSessionCookie(res);
}

/** Récupère l'utilisateur authentifié depuis le cookie de session. */
export function getSessionUser(db, req) {
  const token = parseCookies(req).token;
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!user) return null;
  return { session, user };
}

/**
 * CSRF sans état : token = HMAC(SESSION_SECRET, session.id).
 * Rien à stocker, comparé en temps constant.
 */
export function csrfToken(session, secret) {
  return crypto.createHmac("sha256", secret).update(session.id).digest("hex");
}

export function checkCsrf(provided, expected) {
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Workspace actif : première adhésion de l'utilisateur. */
export function resolveWorkspace(db, userId) {
  return (
    db.prepare(
      `SELECT organization_id FROM organization_members
       WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`
    ).get(userId)?.organization_id || null
  );
}

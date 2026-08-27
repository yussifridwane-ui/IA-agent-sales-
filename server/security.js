// server/security.js — utilitaires de sécurité : crypto, cookies, validation, rate limiting
import crypto from "node:crypto";

export const nowIso = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Échappement HTML systématique (protection XSS) — à utiliser sur TOUTE valeur dynamique. */
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------- Mot de passe : PBKDF2-SHA256 (210 000 itérations) + sel aléatoire ---------- */
/* Format stocké : pbkdf2:<iterations>:<saltHex>:<hashHex>
   Compat lecture : s2:<salt>:<hash> (scrypt historique) — re-hash à la prochaine connexion. */

export const PBKDF2_ITERATIONS = 210_000;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITERATIONS, 32, "sha256");
  return `pbkdf2:${PBKDF2_ITERATIONS}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split(":");
    const scheme = parts[0];
    if (scheme === "pbkdf2") {
      const iterations = Number(parts[1]);
      const salt = Buffer.from(parts[2], "hex");
      const hash = Buffer.from(parts[3], "hex");
      if (!Number.isFinite(iterations) || iterations < 1000 || salt.length < 8 || hash.length < 16) return false;
      const test = crypto.pbkdf2Sync(String(pw), salt, iterations, hash.length, "sha256");
      return crypto.timingSafeEqual(hash, test);
    }
    // Legacy scrypt (s2:salt:hash)
    if (scheme === "s2") {
      const salt = parts[1];
      const hash = parts[2];
      const test = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
      return crypto.timingSafeEqual(Buffer.from(hash, "hex"), test);
    }
    return false;
  } catch {
    return false;
  }
}

/** Indique si le hash stocké doit être migré vers PBKDF2. */
export function needsPasswordRehash(stored) {
  return !String(stored || "").startsWith("pbkdf2:");
}

/* ---------- Cookies de session ---------- */

export function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

export function setSessionCookie(res, token, { secure, maxAge }) {
  res.setHeader(
    "Set-Cookie",
    `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

/* ---------- Validation des entrées ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (e) => EMAIL_RE.test(String(e).slice(0, 254));

export function isValidPhone(p) {
  if (p === "" || p === null || p === undefined) return true; // optionnel
  const d = String(p).replace(/[^\d]/g, "");
  return /^[+\d][\d\s().-]*$/.test(String(p)) && d.length >= 8 && d.length <= 15;
}

/** Nettoie un texte court : supprime les contrôleurs, borne la longueur. */
export function cleanText(s, max = 80) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

export function isValidUrl(u) {
  if (!u) return true; // champ optionnel
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

/* ---------- Rate limiting simple par clé (IP) ---------- */

export function createRateLimiter() {
  const map = new Map();
  return (key, limit, windowMs) => {
    const now = Date.now();
    let rec = map.get(key);
    if (!rec || now > rec.reset) rec = { count: 0, reset: now + windowMs };
    rec.count++;
    map.set(key, rec);
    if (map.size > 10000) map.clear();
    return rec.count <= limit;
  };
}

export const rateLimiter = createRateLimiter();

export function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

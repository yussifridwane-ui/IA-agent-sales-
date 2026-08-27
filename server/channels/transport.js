// server/channels/transport.js — Phase 6 : transport HTTP/SMTP injectable
// - En production : fetch natif (Node ≥ 18) + dialogues SMTP node:net/tls.
// - En test (APP_ENV=test) : transport MOCK en mémoire — les requêtes sont
//   enregistrées et une réponse simulée est renvoyée. Aucun appel réseau réel
//   n'est effectué par la suite de tests (hermétique, déterministe).
// Principe : jamais de confirmation inventée — ce que le transport renvoie
// (succès/échec) est ce qui est enregistré.

import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

export const isTestEnv = () => process.env.APP_ENV === "test" || process.env.CHANNEL_TRANSPORT === "mock";

/** État du mock (tests) : requêtes enregistrées + configuration de réponse.
 *  (Le mock vit dans le processus SERVEUR ; il est piloté par l'endpoint
 *  de test /api/channels/mock-config — pas importé côté client.) */
export const mock = {
  httpRequests: [],
  smtpDialogues: [],
  config: null, // { verifyStatus?, verifyError?, sendStatus?, sendError? }
};

// Compteur global d'IDs fournisseur (jamais remis à zéro : les IDs provider
// doivent rester UNIQUE dans channel_messages.provider_message_id, même après reset).
let mockSendSeq = 0;

export function resetMock() {
  mock.httpRequests.length = 0;
  mock.smtpDialogues.length = 0;
  mock.config = null;
  // mockSendSeq volontairement non remis à zéro (IDs provider globalement uniques)
}

function mockResponse(req) {
  const cfg = mock.config || {};
  const isVerify = req.method === "GET";
  const status = isVerify ? (cfg.verifyStatus ?? 200) : (cfg.sendStatus ?? 200);
  if (status >= 400) {
    return { status, data: { error: { message: cfg.verifyError || cfg.sendError || `HTTP ${status}` } }, error: cfg.verifyError || cfg.sendError || `HTTP ${status}` };
  }
  if (!isVerify && /\/messages$/.test(req.url)) {
    const n = ++mockSendSeq;
    return { status: 200, data: { messages: [{ id: `wamid.MOCK.${n}` }], message_id: `mid.MOCK.${n}`, id: `ig.MOCK.${n}` } };
  }
  return { status: 200, data: { ok: true } };
}

/**
 * Requête JSON HTTP (client API officielle).
 * Renvoie { ok, status, data, error } — jamais d'exception non capturée.
 */
export async function httpJson(method, url, { token = null, body = null, timeoutMs = 10000 } = {}) {
  if (isTestEnv()) {
    const req = { method, url, token, body, id: randomUUID() };
    mock.httpRequests.push(req);
    const res = mockResponse(req);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data, error: res.error || (res.status >= 400 ? `HTTP ${res.status}` : null) };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    clearTimeout(t);
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = data?.error?.message || data?.message || `HTTP ${r.status}`;
      return { ok: false, status: r.status, data, error: String(err) };
    }
    return { ok: true, status: r.status, data, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.name === "AbortError" ? "Timeout" : String(e.message || e) };
  }
}

/**
 * Dialogue SMTP minimal (EHLO → [STARTTLS] → AUTH LOGIN → MAIL/RCPT/DATA → QUIT).
 * Renvoie { ok, message_id, error } — jamais de faux succès : le 250 final de
 * DATA est obligatoire pour considérer l'envoi comme réussi.
 */
export function smtpSend({ host, port = 587, secure = false, user = null, pass = null, from, to, subject, text, inReplyTo = null, references = null, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const lines = [];
    const fail = (error) => { try { sock.destroy(); } catch {} resolve({ ok: false, message_id: null, error: String(error) }); };
    let buffer = "";
    let stage = 0;
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }) : net.connect({ host, port });
    const timer = setTimeout(() => fail("Timeout SMTP"), timeoutMs);
    const send = (line) => { lines.push(`S> ${line}`); sock.write(line + "\r\n"); };
    sock.on("error", (e) => { clearTimeout(timer); fail(e.message); });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        lines.push(`C> ${line}`);
        const code = Number(line.slice(0, 3));
        if (line[3] !== " " && code !== 220) continue; // lignes multi-continuation (250-…)
        switch (stage) {
          case 0: // 220 greeting
            if (code === 220) { stage = 1; send(`EHLO sales-agent.local`); }
            break;
          case 1: // 250 EHLO
            if (code === 250) {
              stage = 2;
              if (secure && !sock.authorized && sock.authorized !== undefined) { /* STARTTLS si disponible */ send("STARTTLS"); }
              else advance();
            }
            break;
          case 2: // 220 après STARTTLS, ou avance directe
            if (code === 220) { stage = 3; send(`EHLO sales-agent.local`); }
            else advance();
            break;
          case 3: // 250 EHLO (2)
            if (code === 250) advance();
            break;
          case 4: // AUTH
            if (code === 334) { stage = 5; send(Buffer.from(pass || "").toString("base64")); }
            else if (code === 235) { stage = 6; send(`MAIL FROM:<${from}>`); }
            else if (code === 503) { stage = 6; send(`MAIL FROM:<${from}>`); } // AUTH non requis
            else if (code === 535) fail("AUTH refusée (identifiants invalides)");
            break;
          case 5: // 235 auth ok
            if (code === 235) { stage = 6; send(`MAIL FROM:<${from}>`); }
            else if (code === 535) fail("AUTH refusée (identifiants invalides)");
            break;
          case 6: // 250 MAIL
            if (code === 250) { stage = 7; send(`RCPT TO:<${to}>`); }
            else fail(`MAIL FROM refusé : ${line}`);
            break;
          case 7: // 250 RCPT
            if (code === 250) {
              stage = 8;
              const id = `<${Date.now()}.${randomUUID().slice(0, 8)}@sales-agent.local>`;
              sock._messageId = id;
              send("DATA");
            } else fail(`RCPT TO refusé : ${line}`);
            break;
          case 8: // 354 DATA
            if (code === 354) {
              stage = 9;
              const hdrs = [
                `From: ${from}`, `To: ${to}`, "Subject: " + subject,
                "MIME-Version: 1.0", 'Content-Type: text/plain; charset="utf-8"',
                `Message-ID: ${sock._messageId}`,
              ];
            if (inReplyTo) hdrs.push(`In-Reply-To: ${inReplyTo}`);
            if (references) hdrs.push(`References: ${references}`);
            const body = [...hdrs, "", text, "."].join("\r\n");
              send(body);
            } else fail(`DATA refusé : ${line}`);
            break;
          case 9: // 250 transmis
            if (code === 250) { stage = 10; send("QUIT"); }
            else fail(`Envoi refusé : ${line}`);
            break;
          case 10: // 221 quit
            clearTimeout(timer);
            done({ ok: true, message_id: sock._message_id || sock._messageId || null, error: null });
            break;
          default:
            if (code >= 500) fail(line);
            break;
        }
      }
    });
    function advance() {
      if (user) { stage = 4; send("AUTH LOGIN"); }
      else { stage = 6; send(`MAIL FROM:<${from}>`); }
    }
    // mode mock : on ne connecte rien, on simule un dialogue (réussi par défaut)
    if (isTestEnv()) {
      clearTimeout(timer);
      sock.destroy();
      const cfg = mock.config || {};
      const failed = (cfg.smtpStatus ?? 200) >= 400;
      const dialogue = { host, port, from, to, subject, text, ok: !failed, message_id: `<mock.${Date.now()}@smtp>`, in_reply_to: inReplyTo || null, references: references || null };
      mock.smtpDialogues.push(dialogue);
      if (failed) return resolve({ ok: false, message_id: null, error: cfg.smtpError || "Échec SMTP simulé" });
      resolve({ ok: true, message_id: dialogue.message_id, error: null });
      return;
    }
  });
}

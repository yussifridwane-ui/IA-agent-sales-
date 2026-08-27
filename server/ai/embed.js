// server/ai/embed.js — pipeline de traitement documentaire local (hors-ligne)
// Document → nettoyage → découpage en chunks → embeddings (vecteurs sparse)
// → recherche par similarité cosinus, TOUJOURS filtrée par organization_id.
// Architecture prête pour pgvector : remplacer embedChunk() par des embeddings
// denses du fournisseur IA sans changer l'API de recherche.
import { randomUUID } from "node:crypto";

const STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "d'", "l'", "et", "ou", "ou", "a",
  "au", "aux", "en", "dans", "sur", "pour", "par", "avec", "sans", "que", "qui", "quoi",
  "dont", "ce", "cet", "cette", "ces", "se", "son", "sa", "ses", "est", "sont", "être",
  "avoir", "nous", "vous", "ils", "elles", "il", "je", "tu", "ils", "y", "ne", "pas",
  "plus", "moins", "bien", "peut", "pourrait", "aller", "faire", "comme", "aussi",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "without",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these",
  "those", "i", "you", "he", "she", "we", "they", "me", "my", "your", "our", "their",
  "will", "can", "could", "should", "would", "do", "does", "did", "has", "have", "had",
]);

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['']/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Découpage en chunks de ~maxChars max, aux limites de phrases. */
export function chunkText(text, maxChars = 700) {
  const clean = String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + " " + s).length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = s;
      // phrase trop longue : découpage dur
      while (cur.length > maxChars) {
        let cut = cur.lastIndexOf(" ", maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        chunks.push(cur.slice(0, cut).trim());
        cur = cur.slice(cut).trim();
      }
    } else {
      cur = cur ? cur + " " + s : s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => c.length > 20);
}

/** Embedding local : vecteur sparse {terme: poids} (TF normalisé). */
export function embedChunk(text) {
  const tokens = tokenize(text);
  const vec = {};
  for (const t of tokens) vec[t] = (vec[t] || 0) + 1;
  // normalisation sub-linéaire
  for (const k of Object.keys(vec)) vec[k] = Math.round((Math.log1p(vec[k])) * 1000) / 1000;
  return vec;
}

function cosine(a, b) {
  // vecteurs sparse {terme: poids}
  let dot = 0, na = 0, nb = 0;
  const keys = Object.keys(a);
  for (const k of keys) {
    na += a[k] * a[k];
    if (b[k]) dot += a[k] * b[k];
  }
  for (const k of Object.keys(b)) nb += b[k] * b[k];
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function embedQuery(text) {
  return embedChunk(text);
}

/**
 * Recherche vectorielle locale — TOUJOURS filtrée par organization_id.
 * Retourne [{ chunk, document, score }] triés par pertinence décroissante.
 */
export function searchChunks(db, { organizationId, query, limit = 3, minScore = 0.04 }) {
  const qv = embedQuery(query);
  if (!Object.keys(qv).length) return [];
  const rows = db.prepare(
    `SELECT kc.id AS chunk_id, kc.content, kc.chunk_index, kc.embedding, kd.id AS document_id, kd.name AS document_name, kd.type AS document_type
     FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id
     WHERE kc.organization_id = ? AND kd.status = 'READY' AND kc.embedding IS NOT NULL`
  ).all(organizationId);
  const scored = [];
  for (const r of rows) {
    let vec = {};
    try { vec = JSON.parse(r.embedding); } catch { continue; }
    const score = cosine(qv, vec);
    if (score >= minScore) scored.push({ chunk: r, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Traite un document : nettoyage → chunks → embeddings → statut READY/FAILED.
 * Retourne le nombre de chunks.
 */
export function processDocument(db, document) {
  try {
    db.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(document.id);
    const chunks = chunkText(document.content);
    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO knowledge_chunks (id, organization_id, document_id, content, chunk_index, embedding, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    chunks.forEach((c, i) => {
      const vec = embedChunk(c);
      ins.run(randomUUID(), document.organization_id, document.id, c, i, JSON.stringify(vec), JSON.stringify({ terms: Object.keys(vec).length }), now);
    });
    db.prepare("UPDATE knowledge_documents SET status = 'READY', error = NULL, updated_at = ? WHERE id = ?").run(now, document.id);
    return chunks.length;
  } catch (e) {
    db.prepare("UPDATE knowledge_documents SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?")
      .run(String(e.message).slice(0, 300), new Date().toISOString(), document.id);
    throw e;
  }
}

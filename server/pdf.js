// server/pdf.js — Phase 7 : générateur PDF minimal, zéro dépendance npm
// PDF 1.4, A4 (595×842 pt), polices Helvetica / Helvetica-Bold (standard,
// encodage WinAnsi → l'accentué français est supporté). Multi-pages.
// Usage : buildPdf([{ text, x?, y?, size?, bold?, gap? }, ...]) → Buffer
//
// Le PDF est un document statique de rendu (devis/commande) : aucun secret
// n'y figure (montants, références, coordonnées client uniquement).

const A4_W = 595;
const A4_H = 842;
const MARGIN = 48;
const LINE_H = 14;

/** Encodage WinAnsi (compatible latin-1) — hors portée → « ? ». */
function toWinAnsi(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    out.push(c <= 0xff ? c : 63);
  }
  return Buffer.from(out);
}

function escapePdf(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Construit un PDF à partir de lignes.
 * line = { text, x (défaut MARGIN), y (défaut auto), size (10), bold (false),
 *          gap (espacement avant, 0), color ["r","g","b"] (défaut noir), break (force page) }
 * Renvoie un Buffer PDF valide.
 */
export function buildPdf(lines) {
  const pages = []; // chaque page : liste d'instructions de contenu
  let page = [];
  let y = A4_H - MARGIN;

  const newPage = () => {
    if (page.length) pages.push(page);
    page = [];
    y = A4_H - MARGIN;
  };

  for (const ln of lines) {
    const size = ln.size || 10;
    const h = Math.max(LINE_H, size * 1.4);
    if (ln.break) newPage();
    const needed = (ln.gap || 0) + h;
    if (y - needed < MARGIN) newPage();
    if (ln.gap) y -= ln.gap;
    y -= h;
    const x = ln.x != null ? ln.x : MARGIN;
    const color = ln.color || [0, 0, 0];
    const font = ln.bold ? "F2" : "F1";
    const text = toWinAnsi(ln.text != null ? String(ln.text) : "");
    page.push(
      `${color[0]} ${color[1]} ${color[2]} rg`,
      `BT /${font} ${size} Tf ${x} ${y.toFixed(2)} Td (${escapePdf(text.toString("latin1"))}) Tj ET`
    );
  }
  newPage();
  if (!pages.length) pages.push([]);

  /* ---------- Assemblage des objets (IDs explicites, sans chevauchement) ---------- */
  // 1 = Catalogue, 2 = Pages, 3 = F1 (Helvetica), 4 = F2 (Helvetica-Bold)
  // Puis : pour chaque page i → Content = 5 + 2i, Page = 6 + 2i
  const pagesId = 2, f1Id = 3, f2Id = 4;
  const contentIdOf = (i) => 5 + 2 * i;
  const pageIdOf = (i) => 6 + 2 * i;
  const nPages = pages.length;
  const totalObjs = 4 + 2 * nPages;

  const body = new Array(totalObjs + 1); // indexé par ID (1-based)
  body[1] = `<</Type /Catalog /Pages ${pagesId} 0 R>>`;
  body[2] = `<</Type /Pages /Kids [${Array.from({ length: nPages }, (_, i) => `${pageIdOf(i)} 0 R`).join(" ")}] /Count ${nPages}>>`;
  body[3] = `<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>`;
  body[4] = `<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>`;
  for (let i = 0; i < nPages; i++) {
    body[pageIdOf(i)] = `<</Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources <</Font <</F1 ${f1Id} 0 R /F2 ${f2Id} 0 R>>>> /Contents ${contentIdOf(i)} 0 R>>`;
    const stream = pages[i].join("\n");
    body[contentIdOf(i)] = `<</Length ${Buffer.byteLength(stream, "binary")}>>\nstream\n${stream}\nendstream`;
  }

  const objs = body;

  /* ---------- Sérialisation + xref ---------- */
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "binary");
}

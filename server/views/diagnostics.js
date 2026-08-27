// server/views/diagnostics.js — page /dashboard/diagnostics
import { esc } from "../security.js";
import { appLayout } from "./app.js";

export function diagnosticsPage({ user, org, role, path, csrf, report }) {
  const summaryClass = report.failed === 0 ? "pass" : "fail";
  const rows = report.results.map((r) => `
    <div class="diag-row ${r.pass ? "is-pass" : "is-fail"}">
      <span class="diag-status ${r.pass ? "pass" : "fail"}">${r.pass ? "PASS" : "FAIL"}</span>
      <div>
        <strong>${esc(r.title)}</strong>
        <div class="diag-meta">${esc(r.detail)}</div>
      </div>
      <code class="muted-sm">${esc(r.id)}</code>
    </div>`).join("");

  const content = `
    <section class="page-head">
      <div>
        <h2>Suite de diagnostics</h2>
        <p class="muted">Vérifications live de l'isolation multi-tenant, de l'anti-hallucination, du hachage des mots de passe et de la persistance.</p>
      </div>
      <button class="btn primary" id="diag-rerun" type="button">Relancer</button>
    </section>

    <div class="diag-summary">
      <div><b class="${summaryClass === "pass" ? "" : ""}" style="color:${report.failed ? "#dc2626" : "#16a34a"}">${report.passed}/${report.total}</b> tests passés</div>
      <div class="muted-sm">Exécuté en ${esc(report.duration_ms)} ms · ${esc((report.ran_at || "").replace("T", " ").slice(0, 19))} UTC</div>
      ${report.pilot ? '<span class="pill" style="color:#16a34a">PILOT_MODE = TRUE</span>' : '<span class="pill" style="color:#f59e0b">PILOT_MODE = FALSE</span>'}
      ${report.failed === 0
        ? '<span class="pill" style="color:#16a34a">0 hallucination · isolation OK</span>'
        : `<span class="pill" style="color:#dc2626">${report.failed} échec(s)</span>`}
    </div>

    <div class="diag-grid" id="diag-results">${rows}</div>

    <div class="card" style="margin-top:18px;padding:16px">
      <h3 style="margin-top:0">Ce que ces tests prouvent</h3>
      <ul class="muted" style="line-height:1.7;margin:0;padding-left:18px">
        <li>Un prix hors catalogue est <b>rejeté</b> avant envoi (garde anti-hallucination).</li>
        <li>L'organisation voisine ne peut <b>pas</b> lire vos produits / leads, même avec un identifiant forgé.</li>
        <li>Les mots de passe sont dérivés en <b>PBKDF2-SHA256</b> (210 000 itérations), jamais stockés en clair.</li>
        <li>Le lead scoring est décomposé en 5 critères publics (30 / 25 / 20 / 15 / 10).</li>
      </ul>
    </div>
    <script>
    (function(){
      var btn = document.getElementById("diag-rerun");
      if (!btn) return;
      btn.addEventListener("click", async function(){
        btn.disabled = true; btn.textContent = "Exécution…";
        try {
          var r = await fetch("/api/diagnostics", { headers: { "X-Requested-With": "fetch", "X-CSRF-Token": document.querySelector('meta[name=csrf-token]')?.content || "" } });
          if (r.ok) location.reload();
          else alert("Échec du diagnostic");
        } catch (e) { alert(e.message); }
        finally { btn.disabled = false; btn.textContent = "Relancer"; }
      });
    })();
    </script>
  `;

  return appLayout({
    title: "Diagnostics",
    user, org, role, path: path || "/dashboard/diagnostics", csrf,
    content,
  });
}

// public/ai.js — interactions Phase 3 : playground, knowledge base, conversations
(function () {
  "use strict";
  const meta = document.querySelector('meta[name="csrf-token"]');
  const csrf = meta ? meta.content : "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toast = (m, t) => window.__toast && window.__toast(m, t);

  async function post(path, data) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-CSRF-Token": csrf },
      body: JSON.stringify({ ...data, _csrf: csrf }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Erreur ${r.status}`), { json: j });
    return j;
  }

  document.addEventListener("DOMContentLoaded", () => {
    /* ---------- Case à cocher : forcer la valeur dans le payload JSON ---------- */
    const forceCheckbox = (formSel, name, attr) => {
      const form = document.querySelector(formSel);
      if (!form) return;
      form.addEventListener("submit", () => {
        const cb = form.querySelector(`input[name="${name}"]`);
        if (!cb) return;
        let h = form.querySelector(`input[data-force="${name}"]`);
        if (!h) { h = document.createElement("input"); h.type = "hidden"; h.name = name; h.setAttribute("data-force", name); form.appendChild(h); }
        h.value = cb.checked ? "1" : "0";
      }, true);
    };
    forceCheckbox("#agentForm", "human_handoff_enabled");
    forceCheckbox("#rulesForm", "negotiation_enabled");

    /* ---------- Page agent : changer le statut ---------- */
    document.querySelectorAll("[data-agent-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const r = await fetch("/api/agent/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-CSRF-Token": csrf },
            body: JSON.stringify({ status: btn.dataset.agentStatus, _csrf: csrf }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Erreur");
          toast(btn.dataset.agentStatus === "ACTIVE" ? "Agent activé ✅" : "Agent en pause.", "success");
          setTimeout(() => location.reload(), 600);
        } catch (e) { toast(e.message, "error"); }
      });
    });

    /* ---------- Playground ---------- */
    const pgForm = document.getElementById("pgForm");
    if (pgForm) {
      let convId = null;
      let busy = false;
      const msgs = document.getElementById("pgMessages");
      const info = document.getElementById("pgInfo");
      const sources = document.getElementById("pgSources");

      const addMsg = (role, text) => {
        const div = document.createElement("div");
        div.className = `msg ${role}`;
        div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
      };
      const addTyping = () => {
        const d = document.createElement("div");
        d.className = "msg agent typing";
        d.id = "pgTyping";
        d.innerHTML = '<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
      };
      const renderInfo = (md) => {
        if (!md) return;
        const rows = [
          ["Intention", md.intent || "—"],
          ["Confiance", md.confidence || "—"],
          ["Lead score", md.lead_score != null ? `${md.lead_score} / 100` : "—"],
          ["Produit ciblé", md.selected || "—"],
        ];
        info.innerHTML = rows.map(([k, v]) => `<div class="ob-line"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
        if (md.products?.length) info.innerHTML += `<div class="ob-line"><span>Produits détectés</span><b>${md.products.map(esc).join(", ")}</b></div>`;
        if (md.tool_calls?.length) info.innerHTML += `<div class="ob-line"><span>Outils</span><b>${md.tool_calls.map(esc).join(", ")}</b></div>`;
        if (md.actions?.length) info.innerHTML += `<div class="ob-line"><span>Actions CRM</span><b>${md.actions.map(esc).join(", ")}</b></div>`;
        if (md.handoff) info.innerHTML += '<div class="alert error" style="margin:8px 0 0">Transfert à un conseiller effectué.</div>';
        sources.innerHTML = md.sources?.length
          ? `<h4 style="margin:10px 0 4px;font-size:12px">Sources utilisées</h4>` + md.sources.map((s) => `<div class="ob-line"><span>${esc(s.document)}</span><b>${s.relevance_score}</b></div>`).join("")
          : "";
      };

      pgForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (busy) return;
        const input = document.getElementById("pgInput");
        const text = input.value.trim();
        if (!text) return;
        busy = true;
        input.value = "";
        addMsg("user", text);
        addTyping();
        try {
          const j = await post("/api/ai/playground", { conversation_id: convId, message: text });
          convId = j.conversation_id;
          document.getElementById("pgTyping")?.remove();
          addMsg("agent", j.reply);
          renderInfo(j.metadata);
        } catch (err) {
          document.getElementById("pgTyping")?.remove();
          addMsg("agent", err.message || "Erreur");
        }
        busy = false;
        input.focus();
      });

      document.getElementById("pgReset").addEventListener("click", () => {
        convId = null;
        msgs.innerHTML = "";
        info.innerHTML = '<span class="muted">Nouvelle conversation démarrée.</span>';
        sources.innerHTML = "";
      });
    }

    /* ---------- Knowledge Base : tester le RAG ---------- */
    const kbForm = document.getElementById("kbTestForm");
    if (kbForm) {
      kbForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const q = document.getElementById("kbTestQuery").value.trim();
        const out = document.getElementById("kbTestResult");
        if (!q) return;
        out.innerHTML = '<p class="muted">Recherche…</p>';
        try {
          const j = await post("/api/knowledge/search", { query: q });
          out.innerHTML = `
            <div class="kb-answer"><b>Réponse :</b> ${esc(j.answer)}</div>
            ${j.sources?.length ? `<div class="kb-srcs"><b>Sources :</b>${j.sources.map((s) => `<div class="ob-line"><span>${esc(s.document_name)} <span class="muted-sm">(${esc(s.document_type)})</span></span><b>score ${s.relevance_score}</b></div>`).join("")}</div>` : '<p class="muted">Aucune source trouvée.</p>'}`;
        } catch (err) {
          out.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
        }
      });

      // Voir un document
      document.querySelectorAll("[data-view-doc]").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.getElementById("docViewerName").textContent = btn.dataset.name;
          document.getElementById("docViewerContent").textContent = btn.dataset.content;
          document.getElementById("docViewer").classList.remove("hidden");
        });
      });
      document.getElementById("docViewerClose")?.addEventListener("click", () => document.getElementById("docViewer").classList.add("hidden"));

      // Réindexer
      document.querySelectorAll("[data-reindex]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const j = await post(`/api/knowledge/documents/${btn.dataset.reindex}/reindex`, {});
            toast(j.message, "success");
            setTimeout(() => location.reload(), 700);
          } catch (err) { toast(err.message, "error"); btn.disabled = false; }
        });
      });
    }

    /* ---------- Conversation : résumé ---------- */
    document.querySelectorAll("[data-summary-conversation]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const out = document.getElementById("convSummary");
        out.innerHTML = '<p class="muted">Génération du résumé…</p>';
        try {
          const j = await post(`/api/ai/conversations/${btn.dataset.summaryConversation}/summary`, {});
          const s = j.summary || {};
          out.innerHTML = `<div class="card form-card">
            <div class="card-head"><h3>Résumé de la conversation</h3></div>
            <div class="detail-lines">
              <div class="ob-line"><span>Besoin</span><b>${esc(s.besoin || "—")}</b></div>
              <div class="ob-line"><span>Budget</span><b>${s.budget != null ? esc(String(s.budget)) + " XOF" : "—"}</b></div>
              <div class="ob-line"><span>Produit</span><b>${esc(s.produit || "—")}</b></div>
              <div class="ob-line"><span>Objections</span><b>${s.objections?.length ? esc(s.objections.join(", ")) : "Aucune"}</b></div>
              <div class="ob-line"><span>Urgence</span><b>${s.urgence ? "Oui" : "Non"}</b></div>
              <div class="ob-line"><span>Client</span><b>${esc([s.client?.nom, s.client?.telephone, s.client?.email].filter(Boolean).join(" · ") || "—")}</b></div>
              <div class="ob-line"><span>Prochaine action</span><b>${esc(s.prochaine_action || "—")}</b></div>
            </div>
          </div>`;
        } catch (err) {
          out.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
        }
      });
    });
  });
})();

// public/automation.js — Phase 5 : builder d'automations (WHEN/IF/THEN),
// séquences, campagnes, segments, templates, follow-ups + cloche de notifications.
(function () {
  "use strict";
  function csrf() {
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : "";
  }
  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-CSRF-Token": csrf() },
      body: JSON.stringify(Object.assign({ _csrf: csrf() }, body)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || "Action impossible", "error"); return null; }
    toast(j.message || "Fait ✓", "success");
    setTimeout(() => location.reload(), 600);
    return j;
  }

  /* ---------- Builder automation ---------- */
  const COND_FIELDS = ["lead.score", "lead.status", "lead.priority", "lead.intent", "lead.source", "lead.budget", "lead.created_at", "deal.value", "deal.stage", "customer.country", "customer.city", "last_activity", "last_response", "product.category"];
  const OPS = ["=", "!=", ">", "<", ">=", "<=", "contains", "not_contains", "in", "not_in"];
  const ACTS = {
    CREATE_TASK: ["title", "priority", "due_days"], UPDATE_LEAD: ["status", "notes"], UPDATE_SCORE: ["delta"],
    ADD_NOTE: ["content"], CREATE_ACTIVITY: ["description"], SEND_EMAIL: ["content", "template_id"],
    SEND_MESSAGE: ["channel", "content"], ASSIGN_LEAD: ["user_id"], CREATE_DEAL: ["name"],
    NOTIFY_SALES_AGENT: ["title", "message"], HANDOFF_HUMAN: ["reason"], START_SEQUENCE: ["sequence_id"], STOP_SEQUENCE: [],
  };

  function initAutomationBuilder() {
    const b = document.getElementById("autoBuilder");
    if (!b) return;
    const condBox = document.getElementById("ab-conditions");
    const actBox = document.getElementById("ab-actions");
    function addCond() {
      const row = document.createElement("div");
      row.className = "builder-row cond-row";
      row.style = "margin-bottom:6px;gap:6px";
      row.innerHTML = `<select class="cond-field" style="flex:1.2">${COND_FIELDS.map((f) => `<option>${f}</option>`).join("")}</select>
        <select class="cond-op" style="flex:.7">${OPS.map((o) => `<option>${o}</option>`).join("")}</select>
        <input class="cond-value" style="flex:1.4" placeholder="valeur (ou liste séparée par ,)"/>
        <button type="button" class="btn small ghost cond-del" title="Retirer">✕</button>`;
      row.querySelector(".cond-del").onclick = () => row.remove();
      condBox.appendChild(row);
    }
    function addAct() {
      const row = document.createElement("div");
      row.className = "builder-row act-row";
      row.style = "margin-bottom:6px;gap:6px;flex-wrap:wrap";
      row.innerHTML = `<select class="act-type" style="flex:1.3">${Object.keys(ACTS).map((a) => `<option value="${a}">${a}</option>`).join("")}</select>
        <span class="act-params" style="display:flex;gap:6px;flex:2;flex-wrap:wrap"></span>
        <input class="act-delay" type="number" min="0" max="1440" placeholder="délai (min, optionnel)" style="width:130px"/>
        <button type="button" class="btn small ghost act-del" title="Retirer">✕</button>`;
      const params = row.querySelector(".act-params");
      const typeSel = row.querySelector(".act-type");
      function renderParams() {
        params.innerHTML = (ACTS[typeSel.value] || []).map((p) => `<input data-p="${p}" placeholder="${p}" style="flex:1;min-width:120px"/>`).join("");
      }
      typeSel.onchange = renderParams;
      renderParams();
      row.querySelector(".act-del").onclick = () => row.remove();
      actBox.appendChild(row);
    }
    document.getElementById("ab-add-cond").onclick = addCond;
    document.getElementById("ab-add-action").onclick = addAct;
    addAct(); // une action par défaut
    document.getElementById("ab-create").onclick = () => {
      const name = document.getElementById("ab-name").value.trim();
      const trigger = document.getElementById("ab-trigger").value;
      if (!name) { toast("Nom requis", "error"); return; }
      const conditions = [...condBox.querySelectorAll(".cond-row")].map((r) => {
        const v = r.querySelector(".cond-value").value.trim();
        const op = r.querySelector(".cond-op").value;
        if (op === "in" || op === "not_in") return { field: r.querySelector(".cond-field").value, operator: op, value: v.split(",").map((x) => x.trim()).filter(Boolean) };
        return { field: r.querySelector(".cond-field").value, operator: op, value: v };
      });
      const actions = [...actBox.querySelectorAll(".act-row")].map((r) => {
        const a = { action: r.querySelector(".act-type").value };
        r.querySelectorAll("[data-p]").forEach((i) => { const v = i.value.trim(); if (v) a[i.dataset.p] = v; });
        const d = Number(r.querySelector(".act-delay").value || 0);
        if (d > 0) a.delay_minutes = d;
        return a;
      });
      if (!actions.length) { toast("Au moins une action requise", "error"); return; }
      post("/api/automations", { name, trigger, conditions, actions, status: "ACTIVE" });
    };
  }

  /* ---------- Builder séquences ---------- */
  function initSequenceBuilder() {
    const box = document.getElementById("seq-steps");
    if (!box) return;
    function addStep() {
      const n = box.children.length + 1;
      const row = document.createElement("div");
      row.className = "builder-row";
      row.style = "margin-bottom:6px;gap:6px;flex-wrap:wrap";
      row.innerHTML = `<span class="chip">Étape ${n}</span>
        <select class="st-wait" style="flex:.7"><option value="immediate">immédiat</option><option value="5m">5 min</option><option value="15m">15 min</option><option value="1h">1 h</option><option value="1d" selected>1 jour</option><option value="2d">2 jours</option><option value="3d">3 jours</option><option value="7d">7 jours</option></select>
        <input class="st-content" placeholder="Message (ou subject séparé par |)" style="flex:3"/>
        <button type="button" class="btn small ghost st-del" title="Retirer">✕</button>`;
      row.querySelector(".st-del").onclick = () => { row.remove(); [...box.children].forEach((c, i) => { const chip = c.querySelector(".chip"); if (chip) chip.textContent = `Étape ${i + 1}`; }); };
      box.appendChild(row);
    }
    document.getElementById("seq-add-step").onclick = addStep;
    addStep();
    document.getElementById("seq-create").onclick = () => {
      const name = document.getElementById("seq-name").value.trim();
      const channel = document.getElementById("seq-channel").value;
      const steps = [...box.querySelectorAll(".builder-row")].map((r) => {
        const content = r.querySelector(".st-content").value.trim();
        const [subject, ...rest] = content.split("|");
        return { wait: r.querySelector(".st-wait").value, subject: rest.length ? subject.trim() : null, content: rest.length ? rest.join("|").trim() : content };
      }).filter((s) => s.content);
      if (!name) { toast("Nom requis", "error"); return; }
      if (!steps.length) { toast("Au moins une étape avec message", "error"); return; }
      post("/api/sequences", { name, channel, steps, status: "ACTIVE" });
    };
  }

  /* ---------- Campagnes / segments / templates ---------- */
  function initCampaigns() {
    if (document.getElementById("camp-create")) {
      document.getElementById("camp-create").onclick = () => {
        const name = document.getElementById("camp-name").value.trim();
        const segment_id = document.getElementById("camp-segment").value;
        const template_id = document.getElementById("camp-template").value;
        const channel = document.getElementById("camp-channel").value;
        if (!name || !segment_id || !template_id) { toast("Nom, segment et template requis", "error"); return; }
        post("/api/campaigns", { name, segment_id, template_id, channel });
      };
    }
    if (document.getElementById("seg-create")) {
      document.getElementById("seg-create").onclick = () => {
        const name = document.getElementById("seg-name").value.trim();
        const definition = {};
        const score = document.getElementById("seg-score").value;
        const status = document.getElementById("seg-status").value.trim();
        const days = document.getElementById("seg-days").value;
        if (score) definition.score_min = Number(score);
        if (status) definition.statuses = status.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (days) definition.max_days_inactive = Number(days);
        if (!name) { toast("Nom du segment requis", "error"); return; }
        post("/api/segments", { name, definition });
      };
    }
    if (document.getElementById("tpl-create")) {
      document.getElementById("tpl-create").onclick = () => {
        const name = document.getElementById("tpl-name").value.trim();
        const content = document.getElementById("tpl-content").value.trim();
        const channel = document.getElementById("tpl-channel").value;
        if (!name || !content) { toast("Nom et contenu requis", "error"); return; }
        post("/api/message-templates", { name, content, channel });
      };
    }
  }

  /* ---------- Follow-up manuel ---------- */
  function initFollowup() {
    if (!document.getElementById("fu-create")) return;
    document.getElementById("fu-create").onclick = () => {
      const lead_id = document.getElementById("fu-lead").value.trim();
      const channel = document.getElementById("fu-channel").value;
      const wait = document.getElementById("fu-wait").value;
      const message = document.getElementById("fu-message").value.trim();
      if (!lead_id || !message) { toast("Lead et message requis", "error"); return; }
      post("/api/followups", { lead_id, channel, wait, message });
    };
  }

  /* ---------- Inscrirre des leads à une séquence (sélecteur de leads) ---------- */
  function initSequenceStart() {
    document.querySelectorAll("[data-lead-select]").forEach((btn) => {
      btn.onclick = async () => {
        const r = await fetch("/api/leads?page_size=100", { headers: { "X-Requested-With": "fetch" } });
        const j = await r.json();
        const sel = document.createElement("div");
        sel.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99;display:flex;align-items:center;justify-content:center";
        const opts = (j.leads || []).filter((l) => !["WON", "LOST"].includes(l.status)).map((l) => `<label style="display:block;padding:4px 0"><input type="checkbox" value="${l.id}" style="margin-right:8px"/> ${l.name} <small>(${l.score}/100)</small></label>`).join("");
        sel.innerHTML = `<div style="background:var(--card,#fff);color:var(--text,#111);border-radius:12px;padding:20px;max-width:420px;max-height:70vh;overflow:auto">
          <h3 style="margin:0 0 10px">Inscrire des leads à la séquence</h3>${opts || "<p>Aucun lead disponible.</p>"}
          <div style="display:flex;gap:8px;margin-top:14px"><button class="btn primary" id="seq-start-ok">Démarrer</button><button class="btn ghost" id="seq-start-no">Annuler</button></div></div>`;
        document.body.appendChild(sel);
        sel.querySelector("#seq-start-no").onclick = () => sel.remove();
        sel.querySelector("#seq-start-ok").onclick = () => {
          const ids = [...sel.querySelectorAll("input:checked")].map((i) => i.value);
          if (!ids.length) { toast("Sélectionnez au moins un lead", "error"); return; }
          post(btn.dataset.fetchAction, { lead_ids: ids });
          sel.remove();
        };
      };
    });
  }

  /* ---------- Cloche de notifications ---------- */
  function initNotifications() {
    const btn = document.getElementById("notifBell");
    if (!btn) return;
    const badge = document.getElementById("notifCount");
    let open = false;
    let panel = null;
    async function refresh() {
      const r = await fetch("/api/notifications", { headers: { "X-Requested-With": "fetch" } });
      const j = await r.json();
      if (!r.ok) return;
      badge.textContent = j.unread || 0;
      badge.style.display = j.unread ? "inline-flex" : "none";
      if (panel) {
        panel.querySelector(".notif-list").innerHTML = (j.notifications || []).slice(0, 15).map((n) => `
          <div class="notif-item${n.read ? "" : " unread"}" data-id="${n.id}">
            <div class="notif-title">${n.title}</div>
            ${n.message ? `<div class="notif-msg">${n.message}</div>` : ""}
            <div class="notif-meta">${(n.created_at || "").slice(0, 16).replace("T", " ")}${n.link ? ` · <a href="${n.link}">voir</a>` : ""}</div>
          </div>`).join("") || "<div class='muted-sm' style='padding:10px'>Aucune notification.</div>";
        panel.querySelectorAll(".notif-item").forEach((el) => {
          el.onclick = async () => {
            await fetch(`/api/notifications/${el.dataset.id}/read`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-CSRF-Token": csrf() }, body: JSON.stringify({ _csrf: csrf() }) });
            el.classList.remove("unread");
            const b = document.getElementById("notifCount");
            b.textContent = Math.max(0, Number(b.textContent || 0) - 1);
            if (!b.textContent) b.style.display = "none";
          };
        });
      }
    }
    btn.onclick = async () => {
      open = !open;
      if (open) {
        panel = document.createElement("div");
        panel.id = "notifPanel";
        panel.className = "notif-panel";
        panel.innerHTML = "<div class='notif-list'></div>";
        btn.parentElement.appendChild(panel);
        await refresh();
      } else if (panel) { panel.remove(); panel = null; }
    };
    document.addEventListener("click", (e) => { if (open && !e.target.closest("#notifBell") && !e.target.closest("#notifPanel")) { open = false; if (panel) { panel.remove(); panel = null; } } });
    refresh();
    setInterval(() => { if (!open) refresh(); }, 60000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    initAutomationBuilder();
    initSequenceBuilder();
    initCampaigns();
    initFollowup();
    initSequenceStart();
    initNotifications();
  });
})();

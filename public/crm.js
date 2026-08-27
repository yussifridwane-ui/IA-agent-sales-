// public/crm.js — interactions Phase 2 : Kanban DnD, import CSV, variantes/images, notes…
(function () {
  "use strict";
  const meta = document.querySelector('meta[name="csrf-token"]');
  const csrf = meta ? meta.content : "";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg, type) { if (window.__toast) window.__toast(msg, type); }

  async function req(url, data, method = "POST") {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-CSRF-Token": csrf },
      body: method === "GET" ? undefined : JSON.stringify(data || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Erreur ${r.status}`), { json: j });
    return j;
  }

  document.addEventListener("DOMContentLoaded", () => {
    /* ---------- Formulaire produit : lignes variantes + images ---------- */
    const tplV = document.querySelector("[data-variant-template]");
    const tplI = document.querySelector("[data-image-template]");
    const listV = document.querySelector("[data-variants]");
    const listI = document.querySelector("[data-images]");

    if (listV && tplV) {
      document.querySelector("[data-add-variant]")?.addEventListener("click", () => listV.appendChild(tplV.content.cloneNode(true)));
      document.querySelector("[data-add-image]")?.addEventListener("click", () => tplI && listI && listI.appendChild(tplI.content.cloneNode(true)));
      listV.addEventListener("click", (e) => e.target.matches(".variant-remove") && e.target.closest(".variant-row").remove());
      listI?.addEventListener("click", (e) => e.target.matches(".image-remove") && e.target.closest(".image-row").remove());
      const init = document.getElementById("productInit");
      if (init) {
        const { variants = [], images = [] } = JSON.parse(init.textContent);
        for (const v of variants) {
          const row = tplV.content.cloneNode(true);
          row.querySelector('[name="v_name"]').value = v.name || "";
          row.querySelector('[name="v_sku"]').value = v.sku || "";
          row.querySelector('[name="v_price"]').value = v.price ?? "";
          row.querySelector('[name="v_stock"]').value = v.stock_quantity ?? 0;
          row.querySelector('[name="v_threshold"]').value = v.low_stock_threshold ?? 0;
          listV.appendChild(row);
        }
        for (const im of images) {
          const row = tplI.content.cloneNode(true);
          row.querySelector('[name="i_url"]').value = im.url || "";
          row.querySelector('[name="i_alt"]').value = im.alt_text || "";
          listI.appendChild(row);
        }
      }
    }

    const pForm = document.querySelector("[data-product-form]");
    if (pForm) {
      pForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const btn = pForm.querySelector('[type="submit"]');
        if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
        try {
          const data = Object.fromEntries(new FormData(pForm).entries());
          const variants = [...(listV?.querySelectorAll(".variant-row") || [])].map((r) => ({
            name: r.querySelector('[name="v_name"]').value,
            sku: r.querySelector('[name="v_sku"]').value,
            price: r.querySelector('[name="v_price"]').value,
            stock_quantity: r.querySelector('[name="v_stock"]').value,
            low_stock_threshold: r.querySelector('[name="v_threshold"]').value,
          })).filter((v) => v.name.trim());
          const images = [...(listI?.querySelectorAll(".image-row") || [])].map((r) => ({
            url: r.querySelector('[name="i_url"]').value,
            alt_text: r.querySelector('[name="i_alt"]').value,
          })).filter((v) => v.url.trim());
          data.variants = variants;
          data.images = images;
          data._csrf = csrf;
          const method = pForm.dataset.method || "POST";
          const url = pForm.dataset.id ? `${pForm.action}/${pForm.dataset.id}` : pForm.action;
          const j = await req(url, data, method);
          if (j.redirect) { location.href = j.redirect; return; }
          toast(j.message || "Enregistré ✓", "success");
          setTimeout(() => location.reload(), 700);
        } catch (err) {
          toast(err.message || "Erreur", "error");
        } finally {
          if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
        }
      });
    }

    /* ---------- Kanban : drag & drop ---------- */
    const kanban = document.getElementById("kanban");
    if (kanban) {
      let dragId = null;
      kanban.addEventListener("dragstart", (e) => {
        const card = e.target.closest(".kanban-card");
        if (!card) return;
        dragId = card.dataset.leadId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragId);
        requestAnimationFrame(() => card.classList.add("dragging"));
      });
      kanban.addEventListener("dragend", (e) => e.target.closest?.(".kanban-card")?.classList.remove("dragging"));
      for (const zone of kanban.querySelectorAll("[data-dropzone]")) {
        zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
        zone.addEventListener("dragleave", () => zone.classList.remove("over"));
        zone.addEventListener("drop", async (e) => {
          e.preventDefault();
          zone.classList.remove("over");
          const id = e.dataTransfer.getData("text/plain") || dragId;
          const status = zone.dataset.dropzone;
          if (!id) return;
          const card = kanban.querySelector(`.kanban-card[data-lead-id="${id}"]`);
          if (card && card.dataset.status === status) return;
          try {
            const j = await req(`/api/leads/${id}/move`, { status });
            toast(j.message || "Lead déplacé ✓", "success");
            if (card) {
              zone.appendChild(card);
              card.dataset.status = status;
              const count = zone.closest(".kanban-col")?.querySelector(".kanban-count");
              if (count) count.textContent = zone.querySelectorAll(".kanban-card").length;
            }
          } catch (err) {
            toast(err.message, "error");
          }
        });
      }
    }

    /* ---------- Import CSV : aperçu ligne par ligne ---------- */
    const csvForm = document.getElementById("csvForm");
    if (csvForm) {
      const file = document.getElementById("csvFile");
      const text = document.getElementById("csvText");
      file?.addEventListener("change", () => {
        const f = file.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { text.value = reader.result; };
        reader.readAsText(f);
      });
      window.__csvRows = [];
      csvForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!text.value.trim()) { toast("Aucun contenu CSV à analyser.", "error"); return; }
        const btn = csvForm.querySelector('[type="submit"]');
        if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
        try {
          const j = await req("/api/products/import/preview", { csv: text.value });
          window.__csvRows = j.rows;
          const preview = document.getElementById("csvPreview");
          preview.classList.remove("hidden");
          document.getElementById("csvSummary").textContent =
            `${j.total_rows} ligne(s) détectée(s) — ${j.valid_rows} valide(s), ${j.total_rows - j.valid_rows} avec erreurs.`;
          const table = document.getElementById("csvTable");
          table.innerHTML =
            "<thead><tr><th>Ligne</th><th>Nom</th><th>SKU</th><th>Prix</th><th>Stock</th><th>Catégorie</th><th>Problèmes</th></tr></thead><tbody>" +
            j.rows.map((r) => `<tr class="${r.errors.length ? "row-bad" : ""}">
              <td>${r.line}</td><td>${esc(r.name || "")}</td><td>${esc(r.sku || "")}</td>
              <td>${esc(String(r.price))}</td><td>${esc(String(r.stock))}</td><td>${esc(r.category_id ? "✓" : "—")}</td>
              <td>${r.errors.length ? r.errors.map(esc).join(", ") : "✓"}</td></tr>`).join("") +
            "</tbody>";
          preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (err) {
          toast(err.message, "error");
        } finally {
          if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
        }
      });
      document.querySelector("[data-csv-confirm]")?.addEventListener("click", async () => {
        const valid = (window.__csvRows || []).filter((r) => !r.errors.length);
        if (!valid.length) { toast("Aucune ligne valide à importer.", "error"); return; }
        try {
          const j = await req("/api/products/import", { rows: valid });
          toast(j.message, "success");
          setTimeout(() => location.reload(), 800);
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }

    /* ---------- Notes : édition inline ---------- */
    for (const btn of document.querySelectorAll("[data-edit-note]")) {
      btn.addEventListener("click", async () => {
        const block = btn.closest(".note-block");
        const input = document.createElement("textarea");
        input.rows = 2;
        input.value = btn.dataset.content || "";
        block.textContent = "";
        block.appendChild(input);
        const actions = document.createElement("div");
        actions.className = "note-meta";
        actions.innerHTML = '<button class="btn small primary" data-save>Enregistrer</button> <button class="btn small ghost" data-cancel>Annuler</button>';
        block.appendChild(actions);
        actions.querySelector("[data-save]").addEventListener("click", async () => {
          try {
            const j = await req(`/api/notes/${btn.dataset.noteId}`, { content: input.value }, "PUT");
            toast(j.message, "success");
            setTimeout(() => location.reload(), 500);
          } catch (err) { toast(err.message, "error"); }
        });
        actions.querySelector("[data-cancel]").addEventListener("click", () => location.reload());
      });
    }

    /* ---------- Catégories : basculer la ligne d'édition ---------- */
    for (const btn of document.querySelectorAll("[data-edit-cat]")) {
      btn.addEventListener("click", () => {
        const row = btn.closest("tr")?.nextElementSibling;
        row?.classList.toggle("hidden");
      });
    }

    /* ---------- Tâches : marquer terminée ---------- */
    for (const btn of document.querySelectorAll("[data-task-done]")) {
      btn.addEventListener("click", async () => {
        try {
          const j = await req(`/api/tasks/${btn.dataset.taskDone}`, { status: "COMPLETED" }, "PUT");
          toast(j.message, "success");
          setTimeout(() => location.reload(), 500);
        } catch (err) { toast(err.message, "error"); }
      });
    }

    /* ---------- Fiche produit : ajout d'image ---------- */
    const addImg = document.querySelector("[data-add-image-form]");
    const imgForm = document.querySelector("[data-image-form]");
    if (addImg && imgForm) {
      addImg.addEventListener("click", () => imgForm.classList.toggle("hidden"));
    }

    /* ---------- Formulaires de notes/activités : lier aux entités ---------- */
    for (const form of document.querySelectorAll("[data-note-form], [data-activity-form]")) {
      form.addEventListener("submit", () => {
        const inject = (name, value) => {
          if (!value) return;
          let i = form.querySelector(`input[name="${name}"]`);
          if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = name; form.appendChild(i); }
          i.value = value;
        };
        inject("customer_id", form.dataset.customer);
        inject("lead_id", form.dataset.lead);
        inject("deal_id", form.dataset.deal);
      }, true);
    }
  });
})();

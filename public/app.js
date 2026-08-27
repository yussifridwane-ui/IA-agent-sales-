// public/app.js — interactions applicatives (thème, toasts, formulaires fetch, confirmations)
(function () {
  "use strict";

  const metaCsrf = document.querySelector('meta[name="csrf-token"]');
  const windowCsrf = (window.__csrf = metaCsrf ? metaCsrf.content : "");

  /* ---------- Thème clair / sombre ---------- */
  function applyThemeIcon(btn) {
    const dark = document.documentElement.dataset.theme === "dark";
    btn.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  }
  function initTheme() {
    document.querySelectorAll(".theme-btn").forEach((btn) => {
      applyThemeIcon(btn);
      btn.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("theme", next); } catch (e) {}
        document.querySelectorAll(".theme-btn").forEach(applyThemeIcon);
      });
    });
  }

  /* ---------- Toasts ---------- */
  function toast(message, type = "success") {
    const wrap = document.getElementById("toasts");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity 0.25s ease";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }
  window.__toast = toast;

  /* ---------- Soumission de formulaires en fetch (retour visuel systématique) ---------- */
  function initForms() {
    document.querySelectorAll("form[data-fetch]").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
        try {
          const data = Object.fromEntries(new FormData(form).entries());
          if (windowCsrf) data._csrf = windowCsrf;
          const method = form.dataset.method || (form.method === "GET" ? "GET" : "POST");
          const url = form.dataset.id ? `${form.action}/${form.dataset.id}` : form.action;
          const r = await fetch(url, {
            method,
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "fetch",
              "X-CSRF-Token": windowCsrf,
            },
            body: method === "GET" ? undefined : JSON.stringify(data),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast(j.error || `Erreur (${r.status})`, "error");
            return;
          }
          if (j.redirect) { location.href = j.redirect; return; }
          toast(j.message || "Enregistré ✓", "success");
          if (method === "GET") location.reload();
          else if (form.dataset.stay !== "on") form.reset();
        } catch (err) {
          toast("Erreur réseau — réessayez.", "error");
        } finally {
          if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
        }
      });
    });
  }

  /* ---------- Actions avec confirmation (retrait de membre…) ---------- */
  function initConfirmActions() {
    document.querySelectorAll("[data-confirm][data-fetch-action]").forEach((el) => {
      el.addEventListener("click", async () => {
        if (!window.confirm(el.dataset.confirm)) return;
        el.disabled = true;
        try {
          const r = await fetch(el.dataset.fetchAction, {
            method: el.dataset.method || "POST",
            headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "X-CSRF-Token": windowCsrf },
            body: JSON.stringify({ _csrf: windowCsrf }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { toast(j.error || "Action impossible", "error"); return; }
          toast(j.message || "Fait ✓", "success");
          setTimeout(() => location.reload(), 500);
        } catch {
          toast("Erreur réseau — réessayez.", "error");
        } finally {
          el.disabled = false;
        }
      });
    });
  }

  /* ---------- Sidebar mobile ---------- */
  function initSidebar() {
    const sidebar = document.getElementById("sidebar");
    const scrim = document.getElementById("scrim");
    const menuBtn = document.getElementById("menuBtn");
    if (!sidebar || !menuBtn) return;
    const close = () => { sidebar.classList.remove("open"); scrim?.classList.remove("show"); };
    menuBtn.addEventListener("click", () => { sidebar.classList.add("open"); scrim?.classList.add("show"); });
    scrim?.addEventListener("click", close);
    document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initForms();
    initConfirmActions();
    initSidebar();
  });
})();

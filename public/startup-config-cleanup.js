(() => {
  if (window.__orbitStartupConfigCleanupLoaded) return;
  window.__orbitStartupConfigCleanupLoaded = true;

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function cardTitle(card) {
    return q("summary,h2,h3,strong", card)?.textContent?.trim().toLowerCase() || "";
  }

  function orderTabs() {
    const nav = q("nav.tabs");
    const systems = q('.tab-btn[data-tab="system"]');
    const config = q('.tab-btn[data-tab="config"]');
    const admin = q('.tab-btn[data-tab="admin"]');
    if (!nav || !systems || !config) return;
    systems.insertAdjacentElement("afterend", config);
    if (admin && config.nextElementSibling !== admin) config.insertAdjacentElement("afterend", admin);
  }

  function cleanStartupConfig() {
    const host = q("#config-zone-main");
    if (!host) return;

    const startupCards = qa("details.card,article.card,section.card,.card")
      .filter((card) => ["startup load control", "startup loading"].includes(cardTitle(card)));

    const keep = startupCards.find((card) => cardTitle(card) === "startup load control")
      || q("#startup-config-form")?.closest("details.card,article.card,section.card,.card")
      || startupCards[0];

    startupCards.forEach((card) => {
      if (card !== keep) card.remove();
    });

    if (keep && keep.parentElement !== host) host.prepend(keep);

    const summary = keep && q("summary", keep);
    if (summary) summary.textContent = "Startup configuration";

    const intro = keep && q("p.muted-text", keep);
    if (intro) intro.textContent = "Configure the files used by startup presets. Startup itself is launched from ChatGPT or Claude.";

    const select = q("#startup-config-project");
    if (select && !q('option[value=""]', select)) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose project";
      placeholder.selected = true;
      placeholder.disabled = true;
      select.prepend(placeholder);
      select.value = "";
    }

    const form = q("#startup-config-form");
    if (form && !form.dataset.projectRequired) {
      form.dataset.projectRequired = "1";
      form.addEventListener("submit", (event) => {
        const project = q("#startup-config-project");
        if (project && !project.value) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const message = q("#startup-config-message");
          if (message) message.textContent = "Choose a project before saving.";
          project.focus();
        }
      }, true);
    }

    qa("[id='startup-config-form']").slice(1).forEach((duplicate) => {
      duplicate.closest("details.card,article.card,section.card,.card")?.remove();
    });
  }

  function apply() {
    orderTabs();
    cleanStartupConfig();
  }

  function install() {
    const style = document.createElement("style");
    style.textContent = `
      #tab-config #config-zone-main{display:grid;gap:10px}
      #tab-config #startup-config-form{display:grid;gap:8px}
      #tab-config #startup-config-form textarea{width:100%;box-sizing:border-box;resize:vertical}
      @media(max-width:700px){
        #tab-config #startup-config-form{grid-template-columns:1fr}
        #tab-config #startup-config-form select,
        #tab-config #startup-config-form textarea,
        #tab-config #startup-config-form button{width:100%;max-width:none}
      }
    `;
    document.head.appendChild(style);
    apply();
    document.querySelectorAll(".tab-btn").forEach((button) => {
      if (button.dataset.startupCleanupWired) return;
      button.dataset.startupCleanupWired = "1";
      button.addEventListener("click", () => requestAnimationFrame(apply));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
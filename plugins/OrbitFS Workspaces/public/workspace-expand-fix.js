(() => {
  if (window.__workspaceExpandFixLoaded) return;
  window.__workspaceExpandFixLoaded = true;

  const TAIL_ID = "workspace-list-tail-spacer";

  function listFor(card) {
    return card?.closest("#workspace-admin-list,.workspace-admin-list");
  }

  function ensureTail(list) {
    if (!list) return null;
    let tail = list.querySelector(`#${TAIL_ID}`);
    if (!tail) {
      tail = document.createElement("div");
      tail.id = TAIL_ID;
      tail.setAttribute("aria-hidden", "true");
      list.appendChild(tail);
    }
    return tail;
  }

  function setTailFor(card) {
    const list = listFor(card);
    const tail = ensureTail(list);
    if (!tail) return;
    const cards = [...list.querySelectorAll(".workspace-admin-card")];
    const isLast = cards[cards.length - 1] === card;
    tail.style.height = isLast ? "calc(90vh + env(safe-area-inset-bottom, 0px))" : "32px";
  }

  function setCardExpanded(card, expanded) {
    const toggle = card.querySelector(".workspace-card-toggle");
    const body = card.querySelector(".workspace-card-body");
    if (!toggle || !body) return;
    body.classList.toggle("hidden", !expanded);
    card.classList.toggle("workspace-card-collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    const arrow = toggle.querySelector(".workspace-card-summary-meta span");
    if (arrow) arrow.textContent = expanded ? "v" : ">";
  }

  function collapseOtherCards(card) {
    const list = listFor(card);
    if (!list) return;
    list.querySelectorAll(".workspace-admin-card").forEach((other) => {
      if (other !== card) setCardExpanded(other, false);
    });
  }

  function expandCard(card) {
    collapseOtherCards(card);
    setCardExpanded(card, true);
    setTailFor(card);
    requestAnimationFrame(() => {
      card.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
    });
  }

  function toggleCard(card) {
    const expanded = card.querySelector(".workspace-card-toggle")?.getAttribute("aria-expanded") === "true";
    if (expanded) {
      setCardExpanded(card, false);
      setTailFor(card);
    } else {
      expandCard(card);
    }
  }

  document.addEventListener("click", (event) => {
    const card = event.target.closest(".workspace-admin-card");
    if (!card) return;
    if (event.target.closest(".workspace-open-btn")) return;
    if (event.target.closest("input,select,textarea,a,.workspace-admin-detail button")) return;
    if (event.target.closest("button") && !event.target.closest(".workspace-card-toggle")) return;
    event.preventDefault();
    event.stopPropagation();
    toggleCard(card);
  }, true);

  new MutationObserver(() => {
    document.querySelectorAll("#workspace-admin-list,.workspace-admin-list").forEach(ensureTail);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
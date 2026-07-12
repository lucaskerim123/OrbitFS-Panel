(() => {
  for (const href of ["system-compact.css", "startup-settings.css"]) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
  if (!document.querySelector('script[src="startup-settings.js"]')) {
    const settingsScript = document.createElement("script");
    settingsScript.src = "startup-settings.js";
    settingsScript.async = false;
    document.body.appendChild(settingsScript);
  }

  const DOCX_PREVIEW_SRC = "https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.min.js";
  let docxPreviewPromise = null;

  function loadDocxPreview() {
    if (window.docx?.renderAsync) return Promise.resolve(window.docx);
    if (docxPreviewPromise) return docxPreviewPromise;
    docxPreviewPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = DOCX_PREVIEW_SRC;
      script.async = true;
      script.onload = () => window.docx?.renderAsync ? resolve(window.docx) : reject(new Error("Word Preview loaded without a renderer."));
      script.onerror = () => reject(new Error("Word Preview failed to load."));
      document.head.appendChild(script);
    });
    return docxPreviewPromise;
  }

  async function renderWord(container, arrayBuffer, status) {
    status.textContent = "Rendering Word Preview…";
    const docx = await loadDocxPreview();
    const body = document.createElement("div");
    body.className = "docx-word-body";
    container.replaceChildren(body);
    await docx.renderAsync(arrayBuffer.slice(0), body, body, {
      className: "hive-docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      experimental: true,
      useBase64URL: false,
    });
    status.textContent = "Word Preview · page layout, headers, footers, tables and images";
  }

  async function renderSimple(container, arrayBuffer, status) {
    if (!window.mammoth) throw new Error("Simple Text viewer failed to load.");
    status.textContent = "Rendering Simple Text…";
    const page = document.createElement("div");
    page.className = "docx-page";
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer.slice(0) });
    page.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
    container.replaceChildren(page);
    status.textContent = "Simple Text · formatting simplified for fast reading";
  }

  window.renderDocxPreview = async function renderDocxPreview(container, arrayBuffer) {
    const shell = document.createElement("div");
    shell.className = "docx-viewer-shell";
    const toolbar = document.createElement("div");
    toolbar.className = "docx-viewer-toolbar";
    const label = document.createElement("label");
    label.textContent = "View as";
    const mode = document.createElement("select");
    mode.innerHTML = '<option value="word">Word Preview</option><option value="simple">Simple Text</option>';
    const status = document.createElement("span");
    status.className = "docx-viewer-status";
    label.appendChild(mode);
    toolbar.append(label, status);
    const viewport = document.createElement("div");
    viewport.className = "docx-viewer-viewport";
    shell.append(toolbar, viewport);
    container.replaceChildren(shell);

    const renderMode = async () => {
      mode.disabled = true;
      viewport.innerHTML = '<div class="docx-loading">Loading document…</div>';
      try {
        if (mode.value === "word") await renderWord(viewport, arrayBuffer, status);
        else await renderSimple(viewport, arrayBuffer, status);
      } catch (error) {
        if (mode.value === "word" && window.mammoth) {
          mode.value = "simple";
          status.textContent = `${error.message} Falling back to Simple Text.`;
          try { await renderSimple(viewport, arrayBuffer, status); }
          catch (fallbackError) { viewport.textContent = `Couldn't render this file: ${fallbackError.message}`; }
        } else {
          viewport.textContent = `Couldn't render this file: ${error.message}`;
          status.textContent = "Preview failed";
        }
      } finally {
        mode.disabled = false;
      }
    };

    mode.addEventListener("change", renderMode);
    await renderMode();
  };
})();
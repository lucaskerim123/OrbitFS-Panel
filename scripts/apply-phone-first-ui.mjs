import fs from "node:fs";

function replaceExact(file, from, to) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(from)) throw new Error(`Expected text not found in ${file}: ${from.slice(0, 80)}`);
  fs.writeFileSync(file, source.replace(from, to));
}

replaceExact(
  "public/startup-settings.js",
  'high: { maxFiles: 80, maxCharacters: 700000, perFileCharacters: 90000 },',
  'high: { maxFiles: 250, maxCharacters: 2000000, perFileCharacters: 120000 },'
);

replaceExact(
  "public/system-compact.css",
  '@media (max-width: 620px) {\n  .sys-panel {\n    margin: -0.75rem;\n    padding: 0.75rem;\n  }',
  '@media (max-width: 620px) {\n  .sys-panel {\n    margin: -0.75rem;\n    padding: 0.75rem;\n  }\n\n  .sys-panel details.card > summary {\n    min-height: 48px;\n    padding: 0.8rem;\n    font-size: 0.84rem;\n  }\n\n  .sys-panel .btn-group {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    width: 100%;\n  }\n\n  .sys-panel .btn-group button,\n  .sys-panel .control-btn,\n  .sys-panel .user-form input,\n  .sys-panel .user-form select,\n  .sys-panel .user-form button {\n    min-height: 46px;\n    font-size: 0.82rem;\n  }\n\n  .sys-panel input,\n  .sys-panel select,\n  .sys-panel textarea {\n    font-size: 16px;\n  }'
);

const mobileCss = `\n@media (max-width: 620px) {\n  .startup-settings-actions { display: grid; grid-template-columns: 1fr; }\n  .startup-settings-actions button { min-height: 46px; width: 100%; }\n  .startup-settings-grid input, .startup-settings-grid select, .startup-level input { min-height: 46px; font-size: 16px; }\n  .startup-level { padding: 0.7rem; }\n  .docx-viewer-toolbar select { min-height: 44px; font-size: 16px; }\n}\n`;
fs.appendFileSync("public/startup-settings.css", mobileCss);

console.log("Applied phone-first panel fixes.");

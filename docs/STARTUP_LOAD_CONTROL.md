# Startup Load Control

Replace the existing Default Project setting. OrbitFS must not automatically select a project.

## Startup UI

1. Select project.
2. Select Low, Medium, High or Custom.
3. Review the files and context groups that will load.
4. Start.

Add a separate prominent `MEGA — LOAD ALL OF 0. CORE` button. MEGA is not another load-strength preset.

## Preset editor

Each project has editable Low, Medium and High profiles. Show every configured item with:

- name;
- resolved live OrbitFS path;
- exact file, folder, semantic current-file rule, profile or context-group type;
- required or optional status;
- enabled load strengths;
- current, missing or ambiguous status;
- last successful load.

Custom applies only to the current startup unless explicitly saved over a preset.

## File selection

Use a live OrbitFS file/folder picker. Do not require full paths to be typed. Archive remains excluded unless explicitly requested.

## Runtime request

```json
{
  "project": "1. Legal",
  "loadStrength": "medium",
  "mega": false,
  "selectedItems": [],
  "taskFiles": [],
  "includeArchive": false
}
```

The Panel must display the MCP's actual loaded, skipped, ambiguous and failed results. It must not independently declare startup successful.

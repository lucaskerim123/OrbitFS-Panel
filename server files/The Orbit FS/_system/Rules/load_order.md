# Load Order

Universal Project FireStorm load order:

1. _system/Startup/00_MASTER_STARTUP.md
2. _system/Rules/load_order.md
3. _system/Rules/project_rules.md
4. _system/Rules/saving_rules.md
5. _system/Rules/commands.md
6. _system/Index/file_index.json

Then detect task type.

## Court / Legal / AVO / Evidence

Load:
1. _system/Startup/01_COURT_SYSTEM_STARTUP.md
2. 0. Core (includes Current AVO and Active Orders - shared with Wellbeing)
3. 1. Legal

## Mental Health / Vent / Personal / Profiles

Load:
1. _system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md
2. 0. Core (includes Current AVO and Active Orders - shared with Legal)
3. 2. Wellbeing

Only load 1. Legal if legal context is relevant. 0. Core/Current AVO and
0. Core/Active Orders are always in scope for both projects since they are
shared, not project-specific.

## Media

Load:
1. _system/Startup/03_MEDIA_STARTUP.md
2. _media

## Sorting

New uploads land in _sorter and stay there untouched until the user runs /sortfiles. Do not triage _sorter automatically for any reason. See _system/Rules/commands.md and _system/Rules/saving_rules.md for the workflow.

## Archive Rule

Do not load or search Archive folders unless the user explicitly asks to include archived material.
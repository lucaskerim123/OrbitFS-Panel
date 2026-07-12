# 00_MASTER_STARTUP

Root:
C:\Project FireStorm\The Master Hive

The Master Hive is the core private drive for Project FireStorm.

Before answering anything related to Project FireStorm:

1. Read this file.
2. Read _system/Rules/load_order.md.
3. Read _system/Rules/project_rules.md.
4. Read _system/Rules/saving_rules.md.
5. Read _system/Rules/commands.md.
6. Read _system/Index/file_index.json if it exists.
7. Detect the correct subsystem:
   - Court/case-process/evidence/statements/court documents = 1. Legal
   - AVO/charges/bail/ICO/CCO current-order status = 0. Core/Current AVO and 0. Core/Active Orders (shared with Wellbeing)
   - Mental health/vent/profiles/sessions/personal notes = 2. Wellbeing
   - Photos/videos/audio = Media
8. Load 0. Core for shared truth when relevant.

Core principle:
- 0. Core is shared truth, including AVO and current-orders (ICO/bail/CCO) status shared between Legal and Wellbeing.
- Project folders are working systems.
- 1. Legal is the Court/case-management project folder.
- Archive folders are not loaded unless explicitly requested.
- New uploads go to _sorter and stay there untouched until the user runs /sortfiles - never triage or move _sorter contents automatically.
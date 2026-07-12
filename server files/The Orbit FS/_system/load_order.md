# Master Hive Load Order

Root:
C:\Project FireStorm\The Master Hive

The Master Hive is the source/root drive for Project FireStorm.

## Core load order

Before answering anything related to Project FireStorm:

1. Read root system files:
   - _system/project_rules.md
   - _system/file_index.json

2. Load shared Master Hive source folders first:
   - A) Global Core files
   - B) Global Master Charges - AVO

3. Detect the correct subsystem:
   - Court, legal, AVO, charges, evidence, statements, bail, ICO, CCO, timelines:
     use 1. Master Court System

   - Mental health, venting, profiles, letters, sessions, personal notes:
     use 2. Mental Health System

   - Photos, videos, audio:
     use Media

4. Load the relevant subsystem current files.

5. Search only the relevant subsystem unless the user asks for a full Master Hive search.

## Important A/B rule

A) Global Core files and B) Global Master Charges - AVO are shared Master Hive load-first folders.

They are used by both:
- 1. Master Court System
- 2. Mental Health System

Do not treat A/B references inside project maps as duplicates. They are shared Master Hive sources.

## Archive rule

Do not load archive folders unless explicitly asked.

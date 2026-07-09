# Master Hive Windows Setup

Windows PowerShell setup for **Project FireStorm / The Master Hive**.

This creates a Google Drive-style local folder structure on a Windows VPS and prepares `_system` files for ChatGPT/MCP loading.

## Run setup

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-master-hive.ps1
```

Custom root:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-master-hive.ps1 -Root "D:\Project FireStorm\The Master Hive"
```

Create a scheduled index rebuild every 10 minutes:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-master-hive.ps1 -CreateScheduledTask
```

Overwrite existing starter `_system` files:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-master-hive.ps1 -OverwriteSystemFiles
```

## Recommended MCP root

Point MCP only at:

```text
C:\Project FireStorm\The Master Hive
```

Do **not** expose the full `C:\` drive.

## ChatGPT/MCP instructions

After running setup, copy the content of:

```text
C:\Project FireStorm\The Master Hive\_system\chatgpt_mcp_instructions.md
```

into your Custom GPT / MCP project instructions.

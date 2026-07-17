# OrbitFS Paid Module Boundary

Purpose: split OrbitFS so the Panel can run by itself while commercial systems are delivered as protected addons.

This is a planning boundary only. It does not move code yet.

## Core rule

Public local code can always be edited by the customer. Do not depend on public local code for strong licence protection.

Protect value by keeping paid implementations outside the public repo and by checking entitlement inside each paid component before doing work.

## Public core

The public Panel repo should contain:

- Panel login and local admin shell
- Base file browser
- System status display
- Addon manager UI
- Licence client and status UI
- Placeholder hooks for MCP, Sorter, and Workspaces
- Service controls that only operate installed/licensed services
- Clear unavailable states when an addon is missing, blocked, or unlicensed

The Panel must run without MCP, Sorter, or Workspaces installed.

## Protected addons

These should be treated as protected/commercial modules:

- MCP server implementation
- Sorter implementation
- Workspaces implementation

Each protected addon must check its own entitlement before doing work.

## MCP boundary

MCP is a main system addon, not required for the Panel shell.

Panel behavior:

- MCP missing: Panel still opens and works
- MCP installed but stopped: Panel shows MCP offline
- MCP installed but unlicensed: Panel shows MCP blocked by licence
- MCP licensed: Panel can start/restart MCP
- MCP stop remains allowed only when explicitly needed for service management

MCP implementation should live outside the public Panel repo long-term.

## Sorter boundary

Sorter is a paid addon.

Public Panel should keep:

- Sorter status row
- Attach/detach metadata
- Start/restart/stop controls gated by licence
- Proxy shell that refuses work if Sorter is missing or blocked

Protected Sorter package should keep:

- Real scan logic
- Destination prediction
- Preview/session engine
- Confirm/move execution
- Learning/history logic

## Workspaces boundary

Workspaces is a paid addon.

Public Panel should keep:

- Addon status
- Basic UI mount point
- Blocked/missing state

Protected Workspaces package should keep:

- Workspace routes
- Workspace storage/quota logic
- Members and invitations
- Restore/storage requests
- Workspace permission overrides
- Workspace UI assets

## Licence API boundary

Licence API and Licence Manager stay hosted/private only.

They should control:

- Licence creation
- Component enable/disable
- Installation lock/unlock
- Block/reactivate state
- Expiry
- Audit history
- Signed entitlement response

## Next implementation steps

1. Make Panel treat MCP as an addon-style service instead of required core.
2. Create public stub folders for MCP, Sorter, and Workspaces.
3. Move real Sorter and Workspaces implementations into protected folders or private repos.
4. Move MCP server implementation into protected/private module packaging.
5. Keep service-level licence gates active during start/restart and inside each component.
6. Add signed entitlement token verification after the boundary is clean.

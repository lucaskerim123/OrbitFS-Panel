import { query } from "./db.js";

export async function leaveWorkspace(workspaceId, userId) {
  const result = await query(
    `SELECT w.id,w.name,w.is_main,w.owner_id,wm.permission
     FROM workspaces w
     LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
     WHERE w.id=$1 LIMIT 1`,
    [workspaceId, userId]
  );
  const workspace = result.rows[0];
  if (!workspace) throw new Error("Workspace not found");
  if (workspace.is_main) throw new Error("Main Workspace cannot be left");
  if (String(workspace.owner_id) === String(userId) || workspace.permission === "owner") {
    throw new Error("Transfer ownership before leaving this workspace");
  }
  if (!workspace.permission) throw new Error("You are not a member of this workspace");

  await query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
  await query(
    `DELETE FROM workspace_invitations
     WHERE workspace_id=$1 AND invited_user_id=$2 AND status='pending'`,
    [workspaceId, userId]
  ).catch(() => {});

  return { ok: true, workspaceId, workspaceName: workspace.name };
}

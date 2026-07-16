import { query } from "./db.js";
import { getArchivedWorkspaceForOwner, restoreWorkspace } from "./workspaces.js";
import { createNotification } from "./notifications.js";

function cleanText(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}

async function adminIds() {
  const result = await query("SELECT id FROM users WHERE role='admin' AND status='active'");
  return result.rows.map((row) => row.id);
}

export async function requestWorkspaceRestore(workspaceId, message, actorId, systemRole) {
  const workspace = await getArchivedWorkspaceForOwner(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Archived workspace not found or access denied");
  if (String(workspace.owner_id) !== String(actorId) && systemRole !== "admin") throw new Error("Only the workspace owner can request a restore");
  await query(
    "UPDATE workspace_restore_requests SET status='cancelled',responded_at=now() WHERE workspace_id=$1 AND requested_by=$2 AND status='pending'",
    [workspaceId, actorId]
  );
  const result = await query(
    `INSERT INTO workspace_restore_requests(workspace_id,requested_by,message,status)
     VALUES($1,$2,$3,'pending') RETURNING *`,
    [workspaceId, actorId, cleanText(message)]
  );
  const request = { ...result.rows[0], workspace_name: workspace.name };
  for (const recipientUserId of await adminIds()) {
    await createNotification({
      recipientUserId, workspaceId, actorUserId: actorId,
      category: "workspace_status", eventType: "workspace_restore_request_created",
      title: "Workspace restore requested",
      message: `${workspace.name} (archived) - restore requested by its owner.`,
      severity: "info", metadata: { requestId: request.id }, force: true,
    });
  }
  return request;
}

export async function listWorkspaceRestoreRequests(userId, systemRole) {
  const admin = systemRole === "admin";
  const result = await query(
    `SELECT r.*,w.name AS workspace_name,w.owner_id,
            requester.username AS requested_by_username,
            responder.username AS responded_by_username
     FROM workspace_restore_requests r
     JOIN workspaces w ON w.id=r.workspace_id
     JOIN users requester ON requester.id=r.requested_by
     LEFT JOIN users responder ON responder.id=r.responded_by
     WHERE ($2::boolean AND r.status='pending')
        OR (NOT $2::boolean AND r.requested_by=$1 AND r.status IN ('pending','approved','denied'))
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at DESC
     LIMIT 100`,
    [userId, admin]
  );
  return result.rows;
}

export async function respondWorkspaceRestoreRequest(requestId, decision, adminMessage, actorId, systemRole) {
  if (systemRole !== "admin") throw new Error("Admin access required");
  if (!["approve", "deny"].includes(decision)) throw new Error("Decision must be approve or deny");
  const status = decision === "approve" ? "approved" : "denied";
  const result = await query(
    `UPDATE workspace_restore_requests SET status=$2,admin_message=$3,responded_at=now(),responded_by=$4
     WHERE id=$1 AND status='pending' RETURNING *`,
    [requestId, status, cleanText(adminMessage, 1000), actorId]
  );
  const request = result.rows[0];
  if (!request) throw new Error("Restore request not found");
  const restoredWorkspace = status === "approved" ? await restoreWorkspace(request.workspace_id, systemRole) : null;
  const workspaceName = restoredWorkspace?.name
    || (await query("SELECT name FROM workspaces WHERE id=$1", [request.workspace_id])).rows[0]?.name;
  await createNotification({
    recipientUserId: request.requested_by, workspaceId: request.workspace_id, actorUserId: actorId,
    category: "workspace_status",
    eventType: status === "approved" ? "workspace_restore_request_approved" : "workspace_restore_request_denied",
    title: status === "approved" ? "Workspace restored" : "Restore request denied",
    message: `${workspaceName}: ${cleanText(adminMessage, 1000) || (status === "approved" ? "Your workspace has been restored." : "Your restore request was denied.")}`,
    severity: status === "approved" ? "success" : "warning",
    metadata: { requestId: request.id },
    force: true,
  });
  return { ok: true, request, workspace: restoredWorkspace };
}

export async function cancelWorkspaceRestoreRequest(requestId, actorId, systemRole) {
  const result = await query(
    `UPDATE workspace_restore_requests SET status='cancelled',responded_at=now()
     WHERE id=$1 AND status='pending' AND ($3='admin' OR requested_by=$2)
     RETURNING id`,
    [requestId, actorId, systemRole]
  );
  if (!result.rowCount) throw new Error("Restore request not found or access denied");
  return { ok: true };
}

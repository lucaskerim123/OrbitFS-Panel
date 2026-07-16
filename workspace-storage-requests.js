import { query } from "./db.js";
import { getWorkspaceForUser } from "./workspaces.js";
import { createNotification } from "./notifications.js";

function cleanText(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Requested storage size is invalid");
  return Math.trunc(n);
}

function requestKind(currentBytes, requestedBytes) {
  if (!currentBytes) return "upgrade";
  if (requestedBytes > currentBytes) return "upgrade";
  if (requestedBytes < currentBytes) return "downgrade";
  return "change";
}

async function adminIds() {
  const result = await query("SELECT id FROM users WHERE role='admin' AND status='active'");
  return result.rows.map((row) => row.id);
}

export async function requestWorkspaceStorageChange(workspaceId, requestedBytes, message, actorId, systemRole) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (workspace.is_main) throw new Error("Main Workspace storage is managed directly by admins");
  if (String(workspace.owner_id) !== String(actorId)) throw new Error("Only the workspace owner can request storage changes");  const requestedQuotaBytes = normalizeBytes(requestedBytes);
  const currentQuotaBytes = workspace.storage_quota_mode === "unlimited" ? null : Number(workspace.storage_quota_bytes || 0);
  await query(
    "UPDATE workspace_storage_requests SET status='cancelled',responded_at=now() WHERE workspace_id=$1 AND requested_by=$2 AND status='pending'",
    [workspaceId, actorId]
  );
  const result = await query(
    `INSERT INTO workspace_storage_requests(workspace_id,requested_by,current_quota_bytes,requested_quota_bytes,request_type,message,status)
     VALUES($1,$2,$3,$4,$5,$6,'pending')
     RETURNING *`,
    [workspaceId, actorId, currentQuotaBytes, requestedQuotaBytes, requestKind(currentQuotaBytes, requestedQuotaBytes), cleanText(message)]
  );
  const request = { ...result.rows[0], workspace_name: workspace.name };
  for (const recipientUserId of await adminIds()) {
    await createNotification({ recipientUserId, workspaceId, actorUserId: actorId,
      category: "storage_requests", eventType: "workspace_storage_request_created",
      title: "Storage change requested",
      message: `${workspace.name} requested a storage ${request.request_type}.`,
      severity: "info", metadata: { requestId: request.id, requestedQuotaBytes }, force: true });
  }
  return request;
}

export async function listWorkspaceStorageRequests(userId, systemRole) {
  const admin = systemRole === "admin";  const result = await query(
    `SELECT r.*,w.name AS workspace_name,w.owner_id,
            requester.username AS requested_by_username,
            responder.username AS responded_by_username
     FROM workspace_storage_requests r
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

export async function respondWorkspaceStorageRequest(requestId, decision, adminMessage, actorId, systemRole) {
  if (systemRole !== "admin") throw new Error("Admin access required");
  if (!["approve", "deny"].includes(decision)) throw new Error("Decision must be approve or deny");
  const status = decision === "approve" ? "approved" : "denied";
  const result = await query(
    `UPDATE workspace_storage_requests r SET status=$2,admin_message=$3,responded_at=now(),responded_by=$4
     FROM workspaces w
     WHERE r.id=$1 AND r.workspace_id=w.id AND r.status='pending'
     RETURNING r.*,w.name AS workspace_name,w.storage_quota_bytes AS current_workspace_quota`,
    [requestId, status, cleanText(adminMessage, 1000), actorId]
  );  const request = result.rows[0];
  if (!request) throw new Error("Storage request not found");
  await createNotification({ recipientUserId: request.requested_by, workspaceId: request.workspace_id, actorUserId: actorId,
    category: "storage_requests",
    eventType: status === "approved" ? "workspace_storage_request_approved" : "workspace_storage_request_denied",
    title: status === "approved" ? "Storage request approved" : "Storage request denied",
    message: `${request.workspace_name}: ${cleanText(adminMessage, 1000) || (status === "approved" ? "Your storage request was approved." : "Your storage request was denied.")}`,
    severity: status === "approved" ? "success" : "warning",
    metadata: { requestId: request.id, requestedQuotaBytes: request.requested_quota_bytes, currentQuotaBytes: request.current_workspace_quota },
    force: true });
  return { ok: true, request };
}

export async function cancelWorkspaceStorageRequest(requestId, actorId, systemRole) {
  const result = await query(
    `UPDATE workspace_storage_requests SET status='cancelled',responded_at=now()
     WHERE id=$1 AND status='pending' AND ($3='admin' OR requested_by=$2)
     RETURNING id`,
    [requestId, actorId, systemRole]
  );
  if (!result.rowCount) throw new Error("Storage request not found or access denied");
  return { ok: true };
}

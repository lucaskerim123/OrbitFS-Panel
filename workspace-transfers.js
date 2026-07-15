import { query, pool } from "./db.js";
import { getWorkspaceForUser } from "./workspaces.js";
import { createNotification } from "./notifications.js";

async function activeUserByUsername(username) {
  const result = await query(
    "SELECT id,username,email FROM users WHERE lower(username)=lower($1) AND status='active' LIMIT 1",
    [String(username || "").trim()]
  );
  return result.rows[0] || null;
}

export async function listWorkspaceUserDirectory() {
  const result = await query(
    "SELECT id,username,email FROM users WHERE status='active' ORDER BY username"
  );
  return result.rows;
}

export async function requestWorkspaceTransfer(workspaceId, targetUsername, actorId, systemRole) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (workspace.is_main) throw new Error("Main Workspace cannot be transferred");
  if (String(workspace.owner_id) !== String(actorId)) throw new Error("Only the workspace owner can request a transfer");
  const target = await activeUserByUsername(targetUsername);
  if (!target) throw new Error("Target user not found");
  if (String(target.id) === String(actorId)) throw new Error("You already own this workspace");

  await query(
    "UPDATE workspace_transfer_requests SET status='cancelled',responded_at=now() WHERE workspace_id=$1 AND status='pending'",
    [workspaceId]
  );
  const result = await query(
    `INSERT INTO workspace_transfer_requests(workspace_id,requested_by,target_user_id,status)
     VALUES($1,$2,$3,'pending')
     RETURNING id,workspace_id,target_user_id,status,created_at`,
    [workspaceId, actorId, target.id]
  );
  return { ...result.rows[0], target_username: target.username, target_email: target.email };
}

export async function listTransferRequests(userId, systemRole) {
  const admin = systemRole === "admin";
  const result = await query(
    `SELECT r.id,r.workspace_id,r.status,r.created_at,r.responded_at,
            w.name AS workspace_name,w.owner_id,
            requester.username AS requested_by_username,
            target.username AS target_username,target.email AS target_email
     FROM workspace_transfer_requests r
     JOIN workspaces w ON w.id=r.workspace_id
     JOIN users requester ON requester.id=r.requested_by
     JOIN users target ON target.id=r.target_user_id
     WHERE r.status='pending' AND ($2::boolean OR w.owner_id=$1)
     ORDER BY r.created_at DESC`,
    [userId, admin]
  );
  return result.rows;
}

export async function respondTransferRequest(requestId, decision, actorId, systemRole) {
  if (systemRole !== "admin") throw new Error("Admin access required");
  if (!["approve", "decline"].includes(decision)) throw new Error("Decision must be approve or decline");
  await query("SELECT 1");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT r.*,w.is_main,w.owner_id,w.name AS workspace_name FROM workspace_transfer_requests r
       JOIN workspaces w ON w.id=r.workspace_id
       WHERE r.id=$1 AND r.status='pending' FOR UPDATE`,
      [requestId]
    );
    const request = result.rows[0];
    if (!request) throw new Error("Transfer request not found");
    if (request.is_main) throw new Error("Main Workspace cannot be transferred");
    if (decision === "approve") {
      await client.query("UPDATE workspace_members SET permission='editor',updated_at=now() WHERE workspace_id=$1 AND permission='owner'",[request.workspace_id]);
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,permission,invited_by)
         VALUES($1,$2,'owner',$3)
         ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission='owner',updated_at=now()`,
        [request.workspace_id,request.target_user_id,actorId]
      );
      await client.query("UPDATE workspaces SET owner_id=$2,updated_at=now() WHERE id=$1",[request.workspace_id,request.target_user_id]);
    }

    await client.query(
      "UPDATE workspace_transfer_requests SET status=$2,responded_at=now(),responded_by=$3 WHERE id=$1",
      [requestId, decision === "approve" ? "approved" : "declined", actorId]
    );
    await client.query("COMMIT");
    if(decision==="approve"){
      await createNotification({recipientUserId:request.requested_by,workspaceId:request.workspace_id,actorUserId:actorId,
        category:"ownership_changes",eventType:"workspace_transfer_approved",title:"Workspace transfer approved",
        message:`Ownership of ${request.workspace_name} was transferred.`,severity:"warning"});
      await createNotification({recipientUserId:request.target_user_id,workspaceId:request.workspace_id,actorUserId:actorId,
        category:"ownership_changes",eventType:"workspace_transfer_approved",title:"You now own a workspace",
        message:`You are now the owner of ${request.workspace_name}.`,severity:"success"});
    } else {
      await createNotification({recipientUserId:request.requested_by,workspaceId:request.workspace_id,actorUserId:actorId,
        category:"ownership_changes",eventType:"workspace_transfer_declined",title:"Workspace transfer declined",
        message:`The transfer request for ${request.workspace_name} was declined.`,severity:"info"});
    }
    return { ok:true, approved:decision === "approve", workspaceId:request.workspace_id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelTransferRequest(requestId, actorId, systemRole) {
  const result = await query(
    `UPDATE workspace_transfer_requests r SET status='cancelled',responded_at=now()
     FROM workspaces w
     WHERE r.id=$1 AND r.workspace_id=w.id AND r.status='pending'
       AND ($3='admin' OR w.owner_id=$2)
     RETURNING r.id`,
    [requestId,actorId,systemRole]
  );
  if (!result.rowCount) throw new Error("Transfer request not found or access denied");
  return { ok:true };
}

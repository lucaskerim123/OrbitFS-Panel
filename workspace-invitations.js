import { query } from "./db.js";
import { getWorkspaceForUser, listWorkspaceMembers } from "./workspaces.js";
import { createNotification,notifyWorkspaceOwner } from "./notifications.js";

const INVITE_ROLES = new Set(["editor", "contributor", "viewer"]);

async function requireWorkspaceManager(workspaceId, actorId, systemRole, allowManageMembers=false) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (workspace.is_main && systemRole !== "admin") throw new Error("Only admins can invite users to Main Workspace");
  if (systemRole !== "admin" && workspace.permission !== "owner" && !allowManageMembers) throw new Error("Manage members permission required");
  return workspace;
}

export async function inviteWorkspaceUser(workspaceId, username, permission, actorId, systemRole, allowManageMembers=false) {
  const workspace=await requireWorkspaceManager(workspaceId, actorId, systemRole, allowManageMembers);
  if (!INVITE_ROLES.has(permission)) throw new Error("Invite role must be editor, contributor, or viewer");
  const userResult = await query(
    "SELECT id,username FROM users WHERE lower(username)=lower($1) AND status='active' LIMIT 1",
    [String(username || "").trim()]
  );
  const invited = userResult.rows[0];
  if (!invited) throw new Error("User not found");
  const existing = await query(
    "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, invited.id]
  );
  if (existing.rowCount) throw new Error("User is already a workspace member");
  await query(
    "UPDATE workspace_invitations SET status='revoked',responded_at=now() WHERE workspace_id=$1 AND invited_user_id=$2 AND status='pending'",
    [workspaceId, invited.id]
  );
  const result = await query(
    `INSERT INTO workspace_invitations(workspace_id,invited_user_id,permission,invited_by,status,expires_at)
     VALUES($1,$2,$3,$4,'pending',now()+interval '30 days') RETURNING id,permission,status,created_at,expires_at`,
    [workspaceId, invited.id, permission, actorId]
  );
  await createNotification({
    recipientUserId:invited.id,workspaceId,actorUserId:actorId,
    category:"workspace_invites",eventType:"workspace_invite",
    title:"Workspace invitation",message:`You were invited to ${workspace.name} as ${permission}.`,
    severity:"info",metadata:{permission,invitationId:result.rows[0].id},
  });
  return { ...result.rows[0], username: invited.username };
}

export async function listPendingInvitations(userId) {
  const result = await query(
    `SELECT i.id,i.workspace_id,i.permission,i.status,i.created_at,i.expires_at,
            w.name AS workspace_name,owner.username AS owner_username,
            inviter.username AS invited_by_username
     FROM workspace_invitations i
     JOIN workspaces w ON w.id=i.workspace_id
     LEFT JOIN users owner ON owner.id=w.owner_id
     LEFT JOIN users inviter ON inviter.id=i.invited_by
     WHERE i.invited_user_id=$1 AND i.status='pending'
       AND (i.expires_at IS NULL OR i.expires_at>now())
     ORDER BY i.created_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function listWorkspaceInvitations(workspaceId, actorId, systemRole, allowManageMembers=false) {
  await requireWorkspaceManager(workspaceId, actorId, systemRole, allowManageMembers);
  const result = await query(
    `SELECT i.id,i.permission,i.status,i.created_at,i.expires_at,u.username
     FROM workspace_invitations i
     LEFT JOIN users u ON u.id=i.invited_user_id
     WHERE i.workspace_id=$1 AND i.status='pending'
     ORDER BY i.created_at DESC`,
    [workspaceId]
  );
  return result.rows;
}

export async function respondToWorkspaceInvitation(invitationId, userId, decision) {
  if (!["accept", "decline"].includes(decision)) throw new Error("Decision must be accept or decline");
  await query("BEGIN");
  try {
    const result = await query(
      `SELECT * FROM workspace_invitations
       WHERE id=$1 AND invited_user_id=$2 AND status='pending'
       AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE`,
      [invitationId, userId]
    );
    const invitation = result.rows[0];
    if (!invitation) throw new Error("Invitation not found or expired");
    if (decision === "accept") {
      await query(
        `INSERT INTO workspace_members(workspace_id,user_id,permission,invited_by)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(workspace_id,user_id)
         DO UPDATE SET permission=EXCLUDED.permission,updated_at=now()`,
        [invitation.workspace_id, userId, invitation.permission, invitation.invited_by]
      );
    }
    await query(
      "UPDATE workspace_invitations SET status=$2,responded_at=now() WHERE id=$1",
      [invitationId, decision === "accept" ? "accepted" : "declined"]
    );
    await query("COMMIT");
    const user=(await query("SELECT username FROM users WHERE id=$1",[userId])).rows[0];
    const workspace=(await query("SELECT name,owner_id FROM workspaces WHERE id=$1",[invitation.workspace_id])).rows[0];
    const accepted=decision === "accept";
    const eventTitle=accepted?"Member joined workspace":"Workspace invitation declined";
    const eventMessage=accepted
      ? `${user?.username || "A user"} joined ${workspace?.name || "the workspace"} as ${invitation.permission}.`
      : `${user?.username || "A user"} declined the invitation to ${workspace?.name || "the workspace"}.`;
    await notifyWorkspaceOwner(invitation.workspace_id,{
      actorUserId:userId,category:accepted?"membership_changes":"workspace_invites",
      eventType:accepted?"workspace_joined":"workspace_invite_declined",
      title:eventTitle,message:eventMessage,severity:accepted?"success":"info",
    });
    if(invitation.invited_by && String(invitation.invited_by)!==String(workspace?.owner_id)){
      await createNotification({recipientUserId:invitation.invited_by,workspaceId:invitation.workspace_id,
        actorUserId:userId,category:accepted?"membership_changes":"workspace_invites",
        eventType:accepted?"workspace_joined":"workspace_invite_declined",title:eventTitle,message:eventMessage,
        severity:accepted?"success":"info"});
    }
    return { accepted, workspaceId: invitation.workspace_id };
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
}

export async function revokeWorkspaceInvitation(invitationId, actorId, systemRole, allowManageMembers=false) {
  const result = await query("SELECT i.workspace_id,i.invited_user_id,w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.id=$1", [invitationId]);
  if (!result.rows[0]) throw new Error("Invitation not found");
  await requireWorkspaceManager(result.rows[0].workspace_id, actorId, systemRole, allowManageMembers);
  await query(
    "UPDATE workspace_invitations SET status='revoked',responded_at=now() WHERE id=$1 AND status='pending'",
    [invitationId]
  );
  await createNotification({recipientUserId:result.rows[0].invited_user_id,workspaceId:result.rows[0].workspace_id,
    actorUserId:actorId,category:"workspace_invites",eventType:"workspace_invite_revoked",
    title:"Workspace invitation revoked",message:`Your invitation to ${result.rows[0].workspace_name} was revoked.`,severity:"warning"});
  return { ok: true };
}

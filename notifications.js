import { query } from "./db.js";

export const NOTIFICATION_CATEGORIES = Object.freeze([
  "workspace_invites",
  "membership_changes",
  "role_changes",
  "workspace_status",
  "workspace_messages",
  "global_messages",
  "lifecycle_warnings",
  "ownership_changes",
  "storage_requests",
]);

const CATEGORY_COLUMNS = new Set(NOTIFICATION_CATEGORIES);
const SEVERITIES = new Set(["info", "success", "warning", "critical"]);

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

async function ensurePreferences(userId) {
  await query(
    `INSERT INTO notification_preferences(user_id)
     VALUES($1) ON CONFLICT(user_id) DO NOTHING`,
    [userId]
  );
}
export async function getNotificationPreferences(userId) {
  await ensurePreferences(userId);
  const result = await query(
    `SELECT workspace_invites,membership_changes,role_changes,workspace_status,
            workspace_messages,global_messages,lifecycle_warnings,ownership_changes,storage_requests
     FROM notification_preferences WHERE user_id=$1`,
    [userId]
  );
  return result.rows[0];
}

export async function updateNotificationPreferences(userId, changes = {}) {
  await ensurePreferences(userId);
  const fields = [];
  const values = [];
  for (const category of NOTIFICATION_CATEGORIES) {
    if (changes[category] === undefined) continue;
    values.push(Boolean(changes[category]));
    fields.push(`${category}=$${values.length}`);
  }
  if (!fields.length) return getNotificationPreferences(userId);
  values.push(userId);
  await query(
    `UPDATE notification_preferences SET ${fields.join(",")},updated_at=now()
     WHERE user_id=$${values.length}`,
    values
  );
  return getNotificationPreferences(userId);
}
async function notificationEnabled(userId, category, severity, force) {
  if (force || severity === "critical" || !CATEGORY_COLUMNS.has(category)) return true;
  const preferences = await getNotificationPreferences(userId);
  return preferences?.[category] !== false;
}

export async function createNotification({
  recipientUserId, workspaceId = null, actorUserId = null, messageId = null,
  category, eventType, title, message, severity = "info", metadata = {},
  dedupKey = null, force = false,
}) {
  if (!recipientUserId) return null;
  const cleanCategory = CATEGORY_COLUMNS.has(category) ? category : "global_messages";
  const cleanSeverity = SEVERITIES.has(severity) ? severity : "info";
  if (!(await notificationEnabled(recipientUserId, cleanCategory, cleanSeverity, force))) return null;
  const cleanTitle = cleanText(title, 160);
  const cleanMessage = cleanText(message, 2000);
  if (!cleanTitle || !cleanMessage) throw new Error("Notification title and message are required");
  const result = await query(
    `INSERT INTO notifications(recipient_user_id,workspace_id,actor_user_id,message_id,
       category,event_type,title,message,severity,metadata,dedup_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT(recipient_user_id,dedup_key) WHERE dedup_key IS NOT NULL
     DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_user_id=EXCLUDED.actor_user_id,
       message_id=EXCLUDED.message_id,category=EXCLUDED.category,event_type=EXCLUDED.event_type,
       title=EXCLUDED.title,message=EXCLUDED.message,severity=EXCLUDED.severity,
       metadata=EXCLUDED.metadata,created_at=now(),read_at=NULL,dismissed_at=NULL
     RETURNING *`,
    [recipientUserId,workspaceId,actorUserId,messageId,cleanCategory,cleanText(eventType,80),
      cleanTitle,cleanMessage,cleanSeverity,JSON.stringify(metadata || {}),cleanText(dedupKey,240) || null]
  );
  return result.rows[0];
}
export async function workspaceRecipientIds(workspaceId) {
  const result = await query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN (
       SELECT owner_id AS user_id FROM workspaces WHERE id=$1
       UNION
       SELECT user_id FROM workspace_members WHERE workspace_id=$1
     ) recipients ON recipients.user_id=u.id
     WHERE u.status='active'`,
    [workspaceId]
  );
  return result.rows.map((row) => row.id);
}

export async function notifyWorkspaceMembers(workspaceId, notification, options = {}) {
  const excluded = new Set((options.excludeUserIds || []).map(String));
  const recipients = await workspaceRecipientIds(workspaceId);
  const delivered = [];
  for (const recipientUserId of recipients) {
    if (excluded.has(String(recipientUserId))) continue;
    const item = await createNotification({ ...notification, workspaceId, recipientUserId });
    if (item) delivered.push(item);
  }
  return delivered;
}

export async function notifyWorkspaceOwner(workspaceId, notification) {
  const row = (await query("SELECT owner_id FROM workspaces WHERE id=$1", [workspaceId])).rows[0];
  if (!row?.owner_id) return null;
  return createNotification({ ...notification, workspaceId, recipientUserId: row.owner_id });
}
export async function listNotifications(userId, { limit = 60, unreadOnly = false } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
  const result = await query(
    `SELECT n.id,n.workspace_id,n.category,n.event_type,n.title,n.message,n.severity,
            n.metadata,n.created_at,n.read_at,w.name AS workspace_name,a.username AS actor_username
     FROM notifications n
     LEFT JOIN workspaces w ON w.id=n.workspace_id
     LEFT JOIN users a ON a.id=n.actor_user_id
     WHERE n.recipient_user_id=$1 AND n.dismissed_at IS NULL
       AND ($2::boolean=false OR n.read_at IS NULL)
     ORDER BY (n.read_at IS NULL) DESC,n.created_at DESC LIMIT $3`,
    [userId, Boolean(unreadOnly), safeLimit]
  );
  return result.rows;
}

export async function unreadNotificationCount(userId) {
  const result = await query(
    `SELECT count(*)::int AS count FROM notifications
     WHERE recipient_user_id=$1 AND read_at IS NULL AND dismissed_at IS NULL`,
    [userId]
  );
  return result.rows[0]?.count || 0;
}

export async function markNotificationRead(userId, notificationId) {
  const result = await query(
    `UPDATE notifications SET read_at=COALESCE(read_at,now())
     WHERE id=$1 AND recipient_user_id=$2 AND dismissed_at IS NULL RETURNING id,read_at`,
    [notificationId, userId]
  );
  if (!result.rowCount) throw new Error("Notification not found");
  return result.rows[0];
}
export async function markAllNotificationsRead(userId) {
  const result = await query(
    `UPDATE notifications SET read_at=COALESCE(read_at,now())
     WHERE recipient_user_id=$1 AND dismissed_at IS NULL AND read_at IS NULL`,
    [userId]
  );
  return { ok: true, updated: result.rowCount };
}

export async function dismissNotification(userId, notificationId) {
  const result = await query(
    `UPDATE notifications SET dismissed_at=now(),read_at=COALESCE(read_at,now())
     WHERE id=$1 AND recipient_user_id=$2 RETURNING id`,
    [notificationId, userId]
  );
  if (!result.rowCount) throw new Error("Notification not found");
  return { ok: true };
}

async function recordMessage({ audienceType, workspaceId = null, senderId, title, body, severity, audienceFilter = null }) {
  const cleanTitle=cleanText(title,160);
  const cleanBody=cleanText(body,2000);
  if(!cleanTitle || !cleanBody) throw new Error("Message title and body are required");
  const result = await query(
    `INSERT INTO notification_messages(audience_type,workspace_id,sender_id,title,body,severity,audience_filter)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [audienceType,workspaceId,senderId,cleanTitle,cleanBody,
      SEVERITIES.has(severity) ? severity : "info",cleanText(audienceFilter,80) || null]
  );
  return result.rows[0];
}
export async function sendGlobalNotification({ senderId, audience = "all", title, body, severity = "info" }) {
  const cleanAudience = ["all", "users", "admins"].includes(audience) ? audience : "all";
  const messageRecord = await recordMessage({
    audienceType: "global", senderId, title, body, severity, audienceFilter: cleanAudience,
  });
  const users = (await query(
    `SELECT id FROM users WHERE status='active'
     AND ($1='all' OR ($1='users' AND role='user') OR ($1='admins' AND role='admin'))`,
    [cleanAudience]
  )).rows;
  let delivered = 0;
  for (const user of users) {
    const item = await createNotification({
      recipientUserId: user.id, actorUserId: senderId, messageId: messageRecord.id,
      category: "global_messages", eventType: "global_message", title, message: body,
      severity, metadata: { audience: cleanAudience }, force: severity === "critical",
    });
    if (item) delivered += 1;
  }
  return { message: messageRecord, delivered };
}

export async function sendWorkspaceNotification({ workspaceId, senderId, title, body, severity = "info" }) {
  const messageRecord = await recordMessage({
    audienceType: "workspace", workspaceId, senderId, title, body, severity,
  });
  const delivered = await notifyWorkspaceMembers(workspaceId, {
    actorUserId: senderId, messageId: messageRecord.id,
    category: "workspace_messages", eventType: "workspace_message", title, message: body,
    severity, metadata: { workspaceId }, force: severity === "critical",
  }, { excludeUserIds: [senderId] });
  return { message: messageRecord, delivered: delivered.length };
}

export async function listNotificationMessages(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const result = await query(
    `SELECT m.*,w.name AS workspace_name,u.username AS sender_username
     FROM notification_messages m
     LEFT JOIN workspaces w ON w.id=m.workspace_id
     LEFT JOIN users u ON u.id=m.sender_id
     ORDER BY m.created_at DESC LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

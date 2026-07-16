import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const { Pool } = pg;

let poolConfig;
if (process.env.DATABASE_URL) {
  poolConfig = { connectionString: process.env.DATABASE_URL };
} else {
  const secretsPath = path.join(__dirname, "..", "orbitfs-db-secrets.json");
  let raw = fsSync.readFileSync(secretsPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const secrets = JSON.parse(raw);
  poolConfig = { host: "127.0.0.1", port: 5432, database: "orbitfs", user: "orbitfs_app", password: secrets.orbitfs_app };
}

export const pool = new Pool({ ...poolConfig, max: 10, idleTimeoutMillis: 30000 });
let initialized = false;
let initializing = null;

export async function query(text, params = []) {
  await ensureDatabase();
  return pool.query(text, params);
}

async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(__dirname, filename), "utf8")); }
  catch { return fallback; }
}
async function migrateUsers(client) {
  const users = await readJson("users.json", []);
  for (const user of users) {
    await client.query(
      `INSERT INTO users(username,pin_salt,pin_hash,role,status)
       VALUES($1,$2,$3,$4,'active')
       ON CONFLICT(username) DO UPDATE SET pin_salt=EXCLUDED.pin_salt,pin_hash=EXCLUDED.pin_hash,role=EXCLUDED.role,updated_at=now()` ,
      [String(user.username).toLowerCase(), user.salt || null, user.hash || null, user.role === "admin" ? "admin" : "user"]
    );
  }
}

async function ensureMainWorkspace(client) {
  const admin = await client.query("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1");
  const ownerId = admin.rows[0]?.id || null;
  const root = process.env.HIVE_ROOT || "F:\\OrbitFS Project\\The Orbit FS";
  const result = await client.query(
    `INSERT INTO workspaces(slug,name,description,owner_id,status,storage_quota_mode,storage_quota_bytes,filesystem_root,is_main)
     VALUES('main','Main Workspace','Existing OrbitFS shared filesystem',$1,'active','unlimited',NULL,$2,true)
     ON CONFLICT(slug) DO UPDATE SET filesystem_root=EXCLUDED.filesystem_root,is_main=true
     RETURNING id`, [ownerId, root]
  );
  if (ownerId) await client.query(
    `INSERT INTO workspace_members(workspace_id,user_id,permission)
     VALUES($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission='owner',updated_at=now()`,
    [result.rows[0].id, ownerId]
  );
  return result.rows[0].id;
}
async function migratePermissions(client, workspaceId) {
  const parsed = await readJson("file-permissions.json", { rules: [] });
  for (const rule of parsed.rules || []) {
    const p = rule.permissions || {};
    await client.query(
      `INSERT INTO file_permissions(workspace_id,relative_path,subject_type,subject_value,can_read,can_write,can_download,can_move,can_delete,can_create)
       VALUES($1,$2,'workspace_role','user',$3,$4,$5,$6,$7,$8)
       ON CONFLICT(workspace_id,relative_path,subject_type,subject_value)
       DO UPDATE SET can_read=EXCLUDED.can_read,can_write=EXCLUDED.can_write,can_download=EXCLUDED.can_download,can_move=EXCLUDED.can_move,can_delete=EXCLUDED.can_delete,can_create=EXCLUDED.can_create,updated_at=now()`,
      [workspaceId, String(rule.path || "").replace(/\\/g,"/").replace(/^\/+|\/+$/g,""), p.read ?? true, p.write ?? true, p.download ?? true, p.move ?? true, p.delete ?? true, p.create ?? true]
    );
  }
}

async function ensureWorkspaceFolders(client) {
  const rows = (await client.query("SELECT filesystem_root FROM workspaces WHERE filesystem_root<>''")).rows;
  for (const row of rows) {
    await fs.mkdir(path.join(row.filesystem_root, "_trash"), { recursive:true });
    await fs.mkdir(path.join(row.filesystem_root, "_sorter"), { recursive:true });
  }
}

async function ensureWorkspaceSettings(client) {
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspension_reason text`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS storage_last_scanned_at timestamptz`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS file_count bigint NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS folder_count bigint NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trash_used_bytes bigint NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trash_limit_bytes bigint NOT NULL DEFAULT 209715200`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email text`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS drive_state text NOT NULL DEFAULT 'online' CHECK(drive_state IN ('online','offline'))`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now()`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS offline_at timestamptz`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_due_at timestamptz`);
  await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS lifecycle_notice text`);
  await client.query(`INSERT INTO system_settings(setting_key,setting_value) VALUES
    ('workspace_inactive_days','30'::jsonb),('workspace_offline_warning_days','7'::jsonb),
    ('workspace_delete_after_offline_days','30'::jsonb),('workspace_delete_warning_days','7'::jsonb)
    ON CONFLICT(setting_key) DO NOTHING`);
  await client.query(`CREATE TABLE IF NOT EXISTS sorter_workspace_settings(
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    mode text NOT NULL DEFAULT 'confirm' CHECK(mode IN ('manual','confirm','automatic')),
    auto_threshold numeric NOT NULL DEFAULT 0.90,
    suggestion_threshold numeric NOT NULL DEFAULT 0.60,
    content_scanning boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS sorter_learning(
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    signal_type text NOT NULL,
    signal_value text NOT NULL,
    destination_path text NOT NULL,
    positive_count integer NOT NULL DEFAULT 0,
    negative_count integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,signal_type,signal_value,destination_path)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS workspace_permission_overrides(
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    relative_path text NOT NULL DEFAULT '',
    workspace_role text NOT NULL CHECK(workspace_role IN ('editor','contributor','viewer')),
    can_read boolean NOT NULL DEFAULT true,
    can_write boolean NOT NULL DEFAULT false,
    can_download boolean NOT NULL DEFAULT true,
    can_move boolean NOT NULL DEFAULT false,
    can_delete boolean NOT NULL DEFAULT false,
    can_create boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,relative_path,workspace_role)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS workspace_role_admin_permissions(
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workspace_role text NOT NULL CHECK(workspace_role IN ('editor','contributor','viewer')),
    can_view_settings boolean NOT NULL DEFAULT false,
    can_edit_settings boolean NOT NULL DEFAULT false,
    can_manage_members boolean NOT NULL DEFAULT false,
    can_manage_permissions boolean NOT NULL DEFAULT false,
    can_send_messages boolean NOT NULL DEFAULT false,
    can_use_sorter boolean NOT NULL DEFAULT false,
    can_manage_sorter_settings boolean NOT NULL DEFAULT false,
    can_delete_workspace boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(workspace_id,workspace_role)
  )`);
  await client.query(`ALTER TABLE workspace_role_admin_permissions ADD COLUMN IF NOT EXISTS can_send_messages boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE workspace_role_admin_permissions ADD COLUMN IF NOT EXISTS can_use_sorter boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE workspace_role_admin_permissions ADD COLUMN IF NOT EXISTS can_manage_sorter_settings boolean NOT NULL DEFAULT false`);
  await client.query(`CREATE TABLE IF NOT EXISTS notification_preferences(
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    workspace_invites boolean NOT NULL DEFAULT true,
    membership_changes boolean NOT NULL DEFAULT true,
    role_changes boolean NOT NULL DEFAULT true,
    workspace_status boolean NOT NULL DEFAULT true,
    workspace_messages boolean NOT NULL DEFAULT true,
    global_messages boolean NOT NULL DEFAULT true,
    lifecycle_warnings boolean NOT NULL DEFAULT true,
    ownership_changes boolean NOT NULL DEFAULT true,
    storage_requests boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS storage_requests boolean NOT NULL DEFAULT true`);
  await client.query(`CREATE TABLE IF NOT EXISTS notification_messages(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    audience_type text NOT NULL CHECK(audience_type IN ('global','workspace')),
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
    title text NOT NULL,
    body text NOT NULL,
    severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','success','warning','critical')),
    audience_filter text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS notifications(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    message_id uuid REFERENCES notification_messages(id) ON DELETE SET NULL,
    category text NOT NULL,
    event_type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('info','success','warning','critical')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedup_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    dismissed_at timestamptz
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx ON notifications(recipient_user_id,created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx ON notifications(recipient_user_id,read_at) WHERE dismissed_at IS NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_dedup_idx ON notifications(recipient_user_id,dedup_key) WHERE dedup_key IS NOT NULL`);
  await client.query(`CREATE TABLE IF NOT EXISTS workspace_trash_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    original_path text NOT NULL,
    trash_path text NOT NULL,
    item_name text NOT NULL,
    item_type text NOT NULL CHECK(item_type IN ('file','folder')),
    size_bytes bigint NOT NULL DEFAULT 0,
    deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'trashed' CHECK(status IN ('trashed','restored','purged')),
    purged_by uuid REFERENCES users(id) ON DELETE SET NULL,
    purged_at timestamptz
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS workspace_trash_events_workspace_status_idx
    ON workspace_trash_events(workspace_id,status,deleted_at DESC)`);
  await client.query(`INSERT INTO system_settings(setting_key,setting_value) VALUES
    ('workspace_mode_enabled','true'::jsonb),
    ('sorter_allow_automatic','false'::jsonb),
    ('sorter_allow_content_scanning','false'::jsonb)
    ON CONFLICT(setting_key) DO NOTHING`);  await client.query(`CREATE TABLE IF NOT EXISTS workspace_transfer_requests(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz,
    responded_by uuid REFERENCES users(id) ON DELETE SET NULL
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS workspace_storage_requests(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_quota_bytes bigint,
    requested_quota_bytes bigint NOT NULL,
    request_type text NOT NULL CHECK(request_type IN ('upgrade','downgrade','change')),
    message text,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','cancelled')),
    admin_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz,
    responded_by uuid REFERENCES users(id) ON DELETE SET NULL
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS workspace_storage_requests_status_idx ON workspace_storage_requests(status,created_at DESC)`);
  await client.query(`INSERT INTO system_settings(setting_key,setting_value) VALUES('max_workspaces_per_user','1'::jsonb) ON CONFLICT(setting_key) DO NOTHING`);
}

export async function ensureDatabase() {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await migrateUsers(client);
      const workspaceId = await ensureMainWorkspace(client);
      await migratePermissions(client, workspaceId);
      await ensureWorkspaceSettings(client);
      await ensureWorkspaceFolders(client);
      await client.query("COMMIT");
      initialized = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  })();
  try { await initializing; } finally { initializing = null; }
}

export async function mainWorkspaceId() {
  const result = await query("SELECT id FROM workspaces WHERE is_main=true LIMIT 1");
  if (!result.rows[0]) throw new Error("Main Workspace is missing");
  return result.rows[0].id;
}

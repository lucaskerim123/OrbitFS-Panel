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

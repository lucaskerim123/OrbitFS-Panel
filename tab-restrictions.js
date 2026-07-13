import { query } from "./db.js";

const RESTRICTABLE_TABS = new Set(["sorter"]);
let readyPromise = null;

async function ensureTable() {
  if (!readyPromise) {
    readyPromise = query(`
      CREATE TABLE IF NOT EXISTS user_tab_restrictions (
        user_id text NOT NULL,
        tab_name text NOT NULL,
        restricted boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, tab_name)
      )
    `).catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  await readyPromise;
}

function cleanTabs(tabs) {
  return [...new Set((Array.isArray(tabs) ? tabs : []).map((tab) => String(tab || "").trim().toLowerCase()).filter((tab) => RESTRICTABLE_TABS.has(tab)))];
}

export async function getRestrictedTabs(userId, systemRole = "user") {
  if (systemRole === "admin") return [];
  await ensureTable();
  const result = await query(
    "SELECT tab_name FROM user_tab_restrictions WHERE user_id=$1 AND restricted=true ORDER BY tab_name",
    [String(userId)]
  );
  return result.rows.map((row) => row.tab_name);
}

export async function isTabRestricted(userId, tabName, systemRole = "user") {
  if (systemRole === "admin") return false;
  const tab = String(tabName || "").trim().toLowerCase();
  if (!RESTRICTABLE_TABS.has(tab)) return false;
  const tabs = await getRestrictedTabs(userId, systemRole);
  return tabs.includes(tab);
}

export async function listUserTabRestrictions() {
  await ensureTable();
  const result = await query(`
    SELECT u.id,u.username,u.role,u.status,
      COALESCE(array_remove(array_agg(r.tab_name ORDER BY r.tab_name) FILTER (WHERE r.restricted=true),NULL),ARRAY[]::text[]) AS restricted_tabs
    FROM users u
    LEFT JOIN user_tab_restrictions r ON r.user_id=u.id::text
    WHERE u.status='active'
    GROUP BY u.id,u.username,u.role,u.status
    ORDER BY CASE WHEN u.role='admin' THEN 0 ELSE 1 END,u.username
  `);
  return result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    restrictedTabs: row.role === "admin" ? [] : row.restricted_tabs || [],
  }));
}

export async function setUserTabRestrictions(username, tabs) {
  await ensureTable();
  const userResult = await query(
    "SELECT id,username,role,status FROM users WHERE lower(username)=lower($1) AND status='active' LIMIT 1",
    [String(username || "").trim()]
  );
  const user = userResult.rows[0];
  if (!user) throw new Error("User not found");
  if (user.role === "admin") return { username: user.username, restrictedTabs: [] };

  const restrictedTabs = cleanTabs(tabs);
  await query("BEGIN");
  try {
    await query("DELETE FROM user_tab_restrictions WHERE user_id=$1", [String(user.id)]);
    for (const tab of restrictedTabs) {
      await query(
        `INSERT INTO user_tab_restrictions(user_id,tab_name,restricted,updated_at)
         VALUES($1,$2,true,now())
         ON CONFLICT(user_id,tab_name) DO UPDATE SET restricted=true,updated_at=now()`,
        [String(user.id), tab]
      );
    }
    await query("COMMIT");
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
  return { username: user.username, restrictedTabs };
}

export { RESTRICTABLE_TABS };

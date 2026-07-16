// Automates the "MCP Members" Access policy on the Master Hive MCP Access
// Application, so granting a workspace member MCP access doesn't require
// manually adding them in the Cloudflare dashboard. This only ever touches
// its own dedicated policy (created lazily on first grant) - it never reads
// or writes any other policy on the Application, so a bug here can't affect
// the owner's own login rule.
const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const MEMBER_POLICY_NAME = "MCP Members";
const MEMBER_POLICY_PRECEDENCE = 100;

export function cfConfigured() {
  return !!(process.env.CF_API_TOKEN && process.env.CF_ACCOUNT_ID && process.env.CF_ACCESS_APP_ID);
}

async function cfRequest(path, options = {}) {
  if (!cfConfigured()) throw new Error("Cloudflare Access is not configured (set CF_API_TOKEN, CF_ACCOUNT_ID, CF_ACCESS_APP_ID)");
  const resp = await fetch(`${CF_API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok || body?.success === false) {
    const message = body?.errors?.map((e) => e.message).join("; ") || `Cloudflare API error (${resp.status})`;
    throw new Error(message);
  }
  return body.result;
}

function policiesPath(policyId) {
  const base = `/accounts/${process.env.CF_ACCOUNT_ID}/access/apps/${process.env.CF_ACCESS_APP_ID}/policies`;
  return policyId ? `${base}/${policyId}` : base;
}

function forUpdate(policy, overrides = {}) {
  return {
    name: policy.name,
    decision: policy.decision,
    include: policy.include || [],
    exclude: policy.exclude || [],
    require: policy.require || [],
    precedence: policy.precedence,
    ...overrides,
  };
}

async function findMemberPolicy() {
  const policies = await cfRequest(policiesPath());
  return (policies || []).find((p) => p.name === MEMBER_POLICY_NAME) || null;
}

function hasEmail(policy, email) {
  return (policy.include || []).some((rule) => rule.email?.email?.toLowerCase() === email);
}

export async function addMemberEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw new Error("Email is required to grant MCP access");
  const existing = await findMemberPolicy();
  if (!existing) {
    return cfRequest(policiesPath(), {
      method: "POST",
      body: JSON.stringify({
        name: MEMBER_POLICY_NAME,
        decision: "allow",
        precedence: MEMBER_POLICY_PRECEDENCE,
        include: [{ email: { email: normalized } }],
      }),
    });
  }
  if (hasEmail(existing, normalized)) return existing;
  const include = [...(existing.include || []), { email: { email: normalized } }];
  return cfRequest(policiesPath(existing.id), { method: "PUT", body: JSON.stringify(forUpdate(existing, { include })) });
}

export async function removeMemberEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const existing = await findMemberPolicy();
  if (!existing) return null;
  const include = (existing.include || []).filter((rule) => rule.email?.email?.toLowerCase() !== normalized);
  return cfRequest(policiesPath(existing.id), { method: "PUT", body: JSON.stringify(forUpdate(existing, { include })) });
}

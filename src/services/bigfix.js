// src/services/bigfix.js
const axios = require("axios");
const { collectStrings } = require("../utils/query");
const { getBfAuthContext, joinUrl, getSessionUser } = require("../utils/http");

const moCache = {}; 
const roleAssetsCache = new Map(); 
const ASSET_CACHE_TTL = 15 * 60 * 1000; 

// Per-user cache of "what computers does THIS user see in BigFix right now?"
// Source of truth: query BigFix with the user's own creds; BigFix server-side enforces
// site permissions, group memberships, and any other RBAC layer. This is the same
// way the Computer List page (/api/groups/computers-extended) gets its data — which
// is why the two views must agree.
const visibleCompsCache = new Map();
const VISIBLE_COMPS_TTL = 5 * 60 * 1000;

async function getUserVisibleComputers(req, ctx) {
    const username = (getSessionUser(req) || "unknown").toLowerCase();
    const now = Date.now();

    const cached = visibleCompsCache.get(username);
    if (cached && (now - cached.lastFetch) < VISIBLE_COMPS_TTL) {
        return cached.names;
    }

    try {
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        const { BIGFIX_BASE_URL } = ctx.bigfix;
        const relevance = `(name of it as lowercase) of bes computers`;
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });

        const raw = [];
        if (resp.status === 200 && resp.data?.result) {
            collectStrings(resp.data.result, raw);
        }

        const names = raw.map(n => String(n).trim().toLowerCase()).filter(Boolean);
        visibleCompsCache.set(username, { names, lastFetch: now });
        return names;
    } catch (e) {
        console.warn(`[getUserVisibleComputers] Failed for '${username}': ${e.message}`);
        // Fail closed: return empty rather than risk leaking data to a user whose RBAC we can't confirm.
        // If a stale cache exists, prefer that over nothing so the UI stays usable during transient BF outages.
        if (cached) return cached.names;
        return [];
    }
}

async function getRoleAssets(req, ctx, roleName) {
    const cacheKey = roleName;
    const now = Date.now();
    if (roleAssetsCache.has(cacheKey) && (now - roleAssetsCache.get(cacheKey).lastFetch < ASSET_CACHE_TTL)) {
        return roleAssetsCache.get(cacheKey).data;
    }

    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    try {
        const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
        let roleId = null;
        if (rolesResp.status === 200) {
            const xmlData = String(rolesResp.data || "");
            const roleBlocks = xmlData.split("</Role>");
            for (const block of roleBlocks) {
                if (block.includes(`<Name>${roleName}</Name>`)) {
                    const idMatch = block.match(/<ID>(\d+)<\/ID>/i);
                    if (idMatch) { roleId = idMatch[1]; break; }
                }
            }
        }

        if (!roleId) return { compNames: [], customSites: [], externalSites: [], operators: [], allComputers: false, found: false };

        const url = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
        const resp = await axios.get(url, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        let compNames = [], customSites = [], externalSites = [], operators = [];
        let allComputers = false;

        if (resp.status === 200) {
            const xml = String(resp.data || "");

            const sitesBlockMatch = xml.match(/<Sites>([\s\S]*?)<\/Sites>/i);
            if (sitesBlockMatch) {
                const sitesXml = sitesBlockMatch[1];
                const customRegex = /<CustomSite>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/CustomSite>/gi;
                let customMatch; while ((customMatch = customRegex.exec(sitesXml)) !== null) customSites.push(customMatch[1].trim());

                const externalRegex = /<ExternalSite>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/ExternalSite>/gi;
                let externalMatch; while ((externalMatch = externalRegex.exec(sitesXml)) !== null) externalSites.push(externalMatch[1].trim());
            }

            // Extract the list of operators in this role. Used to share visibility of actions
            // and deployments across teammates: if user A and user B are both members of the
            // same role, A should see actions issued by B and vice-versa.
            //
            // BigFix's <Operators> block contains entries like <Explicit>name</Explicit>,
            // <Implicit>name</Implicit>, etc. We capture all of them generically.
            const opsBlockMatch = xml.match(/<Operators>([\s\S]*?)<\/Operators>/i);
            if (opsBlockMatch) {
                const opsXml = opsBlockMatch[1];
                const opRegex = /<([A-Za-z][A-Za-z0-9]*)\s*>([^<]+)<\/\1>/g;
                let opMatch;
                while ((opMatch = opRegex.exec(opsXml)) !== null) {
                    const name = opMatch[2].trim().toLowerCase();
                    if (name) operators.push(name);
                }
            }

            const compsBlockMatch = xml.match(/<ComputerAssignments>([\s\S]*?)<\/ComputerAssignments>/i);
            if (compsBlockMatch) {
                const compsXml = compsBlockMatch[1];

                // Case 1: <AllComputers/> grants access to every computer the role's site permissions allow.
                // No app-side name filter should be applied; BigFix enforces RBAC via the user's own credentials.
                if (/<AllComputers\s*\/?>/i.test(compsXml)) {
                    allComputers = true;
                } else {
                    // Case 2: explicit name assignments — only collect <Value> from <Property Name="Computer Name"> blocks.
                    // Without this guard, OS/IP/etc. property values get treated as computer names and the relevance never matches.
                    const propRegex = /<Property\b[^>]*\bName\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/Property>/gi;
                    let propMatch;
                    let sawAnyProperty = false;
                    while ((propMatch = propRegex.exec(compsXml)) !== null) {
                        sawAnyProperty = true;
                        if (propMatch[1].trim().toLowerCase() !== "computer name") continue;
                        const valRegex = /<Value>(.*?)<\/Value>/gi;
                        let valMatch;
                        while ((valMatch = valRegex.exec(propMatch[2])) !== null) {
                            compNames.push(valMatch[1].trim().toLowerCase());
                        }
                    }
                    // Fallback: if BigFix returned a shape with no <Property> wrappers, keep the old behavior
                    // so existing working roles don't regress.
                    if (!sawAnyProperty) {
                        const valRegex = /<Value>(.*?)<\/Value>/gi;
                        let valMatch;
                        while ((valMatch = valRegex.exec(compsXml)) !== null) {
                            compNames.push(valMatch[1].trim().toLowerCase());
                        }
                    }
                }
            }
        }

        const data = { compNames, customSites, externalSites, operators: [...new Set(operators)], allComputers, found: resp.status === 200 };
        roleAssetsCache.set(cacheKey, { data, lastFetch: now });
        return data;

    } catch (e) { return { compNames: [], customSites: [], externalSites: [], operators: [], allComputers: false, found: false }; }
}

async function isMasterOperator(req, ctx, operatorName) {
    if (moCache[operatorName] !== undefined) return moCache[operatorName];
    if (!operatorName || operatorName === "unknown") return false;

    try {
        const { BIGFIX_BASE_URL } = ctx.bigfix;
        
        //  CRITICAL FIX: ALWAYS USE MASTER CREDS to verify MO status. Avoids NMO 401 crash.
        const bfAuthOpts = await getBfAuthContext(null, ctx); 
        
        const url = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(operatorName)}`);
        const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
        if (resp.status === 200) {
            const xml = String(resp.data || "");
            const match = xml.match(/<MasterOperator>(.*?)<\/MasterOperator>/i);
            if (match) {
                const isMO = match[1].trim().toLowerCase() === "true" || match[1].trim() === "1";
                moCache[operatorName] = isMO;
                return isMO;
            }
        }
        moCache[operatorName] = false;
        return false;
    } catch (e) {
        moCache[operatorName] = false;
        return false;
    }
}

// Group membership rarely changes minute-to-minute, but the KPI dashboard polls
// every 15s and resolves membership once per group, per request, from both the
// tiles and the detail view. Without a cache that hammered BigFix's /api/query
// with concurrent calls and drove it into HTTP 503s, which surfaced to the UI as
// 500s / empty counts. Cache per group with a short TTL and collapse concurrent
// identical lookups into a single in-flight request.
const _groupMembersCache = new Map();    // groupName -> { data, expiry }
const _groupMembersInflight = new Map();  // groupName -> Promise
const GROUP_MEMBERS_TTL_MS = 5 * 60 * 1000;

const bigfixClient = (req, ctx) => { 
  const config = ctx.bigfix || {};
  const BIGFIX_BASE_URL = config.BIGFIX_BASE_URL || process.env.BIGFIX_BASE_URL;
  if (!BIGFIX_BASE_URL) throw new Error("BigFix URL not configured");

  async function fetchGroupMembers(groupName) {
    // Escape backslashes/quotes so a stray group value (e.g. a pasted test
    // string) can't break out of the relevance expression.
    const safeName = String(groupName).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const relevance = `((name of it | "N/A"), (if (exists values of results (it, bes properties "IP Address")) then (concatenation ", " of values of results (it, bes properties "IP Address")) else "N/A"), (operating system of it | "Unknown")) of members  whose (value of result (it, bes property "Device Type") as lowercase = "server") of bes computer group whose (name of it = "${safeName}")`;

    const bfAuthOpts = await getBfAuthContext(req, ctx);
    const res = await axios.get(`${BIGFIX_BASE_URL}/api/query`, {
      ...bfAuthOpts,
      params: { output: "json", relevance },
      timeout: 60000,
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`BigFix /api/query returned HTTP ${res.status}`);
    }

    const result = res.data?.result;
    const rows = Array.isArray(result) ? result : (result ? [result] : []);
    return rows.map(r => {
      const parts = []; collectStrings(r, parts); const [name, ipStr, os] = parts;
      return { name: name || "Unknown", ips: (ipStr || "").split(";").filter(Boolean), os: os || "Unknown" };
    });
  }

  async function getGroupMembers(groupName) {
    const key = String(groupName || "");
    const now = Date.now();

    const cached = _groupMembersCache.get(key);
    if (cached && now < cached.expiry) return cached.data;

    // Share one BigFix request across concurrent callers for the same group.
    const existing = _groupMembersInflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const data = await fetchGroupMembers(key);
        _groupMembersCache.set(key, { data, expiry: Date.now() + GROUP_MEMBERS_TTL_MS });
        return data;
      } catch (err) {
        // Don't turn a transient BigFix hiccup (503/timeout) into a 500 cascade.
        // Prefer slightly-stale data; otherwise return empty and let the next
        // poll retry, so the caller shows 0 rather than erroring out.
        console.warn(`[getGroupMembers] '${key}' failed: ${err.message}. Serving ${cached ? "stale cache" : "empty list"}.`);
        return cached ? cached.data : [];
      } finally {
        _groupMembersInflight.delete(key);
      }
    })();

    _groupMembersInflight.set(key, promise);
    return promise;
  }
  return { getGroupMembers };
};

module.exports = { bigfixClient, getRoleAssets, isMasterOperator, getUserVisibleComputers };
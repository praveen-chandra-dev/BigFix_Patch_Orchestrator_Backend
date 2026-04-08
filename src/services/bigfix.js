// src/services/bigfix.js
const axios = require("axios");
const { collectStrings } = require("../utils/query");
const { getBfAuthContext, joinUrl } = require("../utils/http");

const moCache = {}; 
const roleAssetsCache = new Map(); 
const ASSET_CACHE_TTL = 15 * 60 * 1000; 

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

        if (!roleId) return { compNames: [], customSites: [], externalSites: [], found: false };

        const url = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
        const resp = await axios.get(url, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        let compNames = [], customSites = [], externalSites = [];

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

            const compsBlockMatch = xml.match(/<ComputerAssignments>([\s\S]*?)<\/ComputerAssignments>/i);
            if (compsBlockMatch) {
                const compsXml = compsBlockMatch[1];
                const valRegex = /<Value>(.*?)<\/Value>/gi;
                let valMatch; while ((valMatch = valRegex.exec(compsXml)) !== null) compNames.push(valMatch[1].trim().toLowerCase());
            }
        }

        const data = { compNames, customSites, externalSites, found: resp.status === 200 };
        roleAssetsCache.set(cacheKey, { data, lastFetch: now });
        return data;

    } catch (e) { return { compNames: [], customSites: [], externalSites: [], found: false }; }
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

const bigfixClient = (req, ctx) => { 
  const config = ctx.bigfix || {};
  const BIGFIX_BASE_URL = config.BIGFIX_BASE_URL || process.env.BIGFIX_BASE_URL;
  if (!BIGFIX_BASE_URL) throw new Error("BigFix URL not configured");

  async function getGroupMembers(groupName) {
    const relevance = `((name of it | "N/A"), (if (exists values of results (it, bes properties "IP Address")) then (concatenation ", " of values of results (it, bes properties "IP Address")) else "N/A"), (operating system of it | "Unknown")) of members  whose (value of result (it, bes property "Device Type") as lowercase = "server") of bes computer group whose (name of it = "${groupName}")`;
    try {
      //  CRITICAL FIX: Use Master Creds for fetching base data, RBAC filters it via Node cache later.
      const bfAuthOpts = await getBfAuthContext(req, ctx);
      const res = await axios.get(`${BIGFIX_BASE_URL}/api/query`, { ...bfAuthOpts, params: { output: "json", relevance } });
      const result = res.data?.result;
      const rows = Array.isArray(result) ? result : (result ? [result] : []);

      return rows.map(r => {
        const parts = []; collectStrings(r, parts); const [name, ipStr, os] = parts;
        return { name: name || "Unknown", ips: (ipStr || "").split(";").filter(Boolean), os: os || "Unknown" };
      });
    } catch (err) { 
      throw new Error(`Failed to fetch members: ${err.message}`); 
    }
  }
  return { getGroupMembers };
};

module.exports = { bigfixClient, getRoleAssets, isMasterOperator };
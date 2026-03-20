// src/services/bigfix.js
const axios = require("axios");
const { collectStrings } = require("../utils/query");
const { getBfAuthContext, joinUrl } = require("../utils/http");

// High-speed memory cache to prevent slow API calls on every request
const moCache = {}; 

// --- HELPER: Parse BigFix Role XML for assigned Sites and Computers ---
async function getRoleAssets(req, ctx, roleName) {
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    try {
        const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };
        
        // 1. BigFix API requires the Role ID. Fetch all roles to map the exact Name to its ID.
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

        // 2. Fetch the specific Role XML using the resolved ID
        const url = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
        const resp = await axios.get(url, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        let compNames = [];
        let customSites = [];
        let externalSites = [];

        if (resp.status === 200) {
            const xml = String(resp.data || "");

            // STRICT PARSING: Accurately isolate Custom vs External Sites
            const sitesBlockMatch = xml.match(/<Sites>([\s\S]*?)<\/Sites>/i);
            if (sitesBlockMatch) {
                const sitesXml = sitesBlockMatch[1];
                
                const customRegex = /<CustomSite>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/CustomSite>/gi;
                let customMatch;
                while ((customMatch = customRegex.exec(sitesXml)) !== null) {
                    customSites.push(customMatch[1].trim());
                }

                const externalRegex = /<ExternalSite>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/ExternalSite>/gi;
                let externalMatch;
                while ((externalMatch = externalRegex.exec(sitesXml)) !== null) {
                    externalSites.push(externalMatch[1].trim());
                }
            }

            // STRICT PARSING: Assigned Computers
            const compsBlockMatch = xml.match(/<ComputerAssignments>([\s\S]*?)<\/ComputerAssignments>/i);
            if (compsBlockMatch) {
                const compsXml = compsBlockMatch[1];
                const valRegex = /<Value>(.*?)<\/Value>/gi;
                let valMatch;
                while ((valMatch = valRegex.exec(compsXml)) !== null) {
                    compNames.push(valMatch[1].trim().toLowerCase());
                }
            }
        }
        return { compNames, customSites, externalSites, found: resp.status === 200 };
    } catch (e) { return { compNames: [], customSites: [], externalSites: [], found: false }; }
}

async function isMasterOperator(req, ctx, operatorName) {
    if (moCache[operatorName] !== undefined) return moCache[operatorName];

    try {
        const { BIGFIX_BASE_URL } = ctx.bigfix;
        const bfAuthOpts = await getBfAuthContext(req, ctx);
        
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
        
        // Fallback
        const relUrl = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("master flag of current console user")}`;
        const relResp = await axios.get(relUrl, { ...bfAuthOpts, headers: { Accept: "application/json" }, validateStatus: () => true });
        if (relResp.status === 200 && relResp.data?.result) {
            const resStr = String(relResp.data.result[0] || relResp.data.result).trim().toLowerCase();
            const isMO = resStr === "true";
            moCache[operatorName] = isMO;
            return isMO;
        }
        moCache[operatorName] = false;
        return false;
    } catch (e) { return false; }
}

const bigfixClient = (req, ctx) => { 
  const config = ctx.bigfix || {};
  const BIGFIX_BASE_URL = config.BIGFIX_BASE_URL || process.env.BIGFIX_BASE_URL;
  if (!BIGFIX_BASE_URL) throw new Error("BigFix URL not configured");

  async function getGroupMembers(groupName) {
    const relevance = `(name of it, (if (exists ip addresses of it) then (concatenations "," of ip addresses of it as string) else "N/A"), (operating system of it | "Unknown")) of members of bes computer group whose (name of it = "${groupName}")`;
    try {
      const bfAuthOpts = await getBfAuthContext(req, ctx); 
      const res = await axios.get(`${BIGFIX_BASE_URL}/api/query`, { ...bfAuthOpts, params: { output: "json", relevance } });
      const result = res.data?.result;
      const rows = Array.isArray(result) ? result : (result ? [result] : []);

      return rows.map(r => {
        const parts = []; collectStrings(r, parts); const [name, ipStr, os] = parts;
        return { name: name || "Unknown", ips: (ipStr || "").split(";").filter(Boolean), os: os || "Unknown" };
      });
    } catch (err) { throw new Error(`Failed to fetch members`); }
  }
  return { getGroupMembers };
};

module.exports = { bigfixClient, getRoleAssets, isMasterOperator };
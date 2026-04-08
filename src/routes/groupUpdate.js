// bigfix-backend/src/routes/groupUpdate.js
const axios = require("axios");
const xml2js = require("xml2js");
const { joinUrl, getBfAuthContext, escapeXML } = require("../utils/http");
const { logFactory } = require("../utils/log");

// Helper to resolve a Property Name to a BigFix Property ID
async function getPropertyIdByName(req, ctx, propertyName) {
    if (!propertyName) return null;
    const { BIGFIX_BASE_URL } = ctx.bigfix;
    const bfAuthOpts = await getBfAuthContext(req, ctx);
    const safeName = propertyName.toLowerCase().replace(/"/g, '""');
    
    let relevance = `(item 1 of it) of ids of bes properties whose (name of it as lowercase = "${safeName}" and reserved flag of it = true)`;
    try {
        let url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        let resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        let result = resp.data?.result;
        let raw = Array.isArray(result) ? result : (result ? [result] : []);
        if (raw.length > 0) return String(raw[0]);
        
        relevance = `(item 1 of it) of ids of bes properties whose (name of it as lowercase = "${safeName}")`;
        url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/json" } });
        result = resp.data?.result;
        raw = Array.isArray(result) ? result : (result ? [result] : []);
        if (raw.length > 0) return String(raw[0]);
    } catch (e) {}
    return null;
}

// Helper to find exactly where a group lives (master vs custom site) and parse its type
async function getGroupSiteLocation(req, ctx, groupId) {
    const bfAuthOpts = await getBfAuthContext(req, ctx);
    const bfUrl = bfAuthOpts.baseURL || (ctx.cfg?.BIGFIX_BASE_URL || "").replace(/\/$/, "");

    // Extracts Name, SiteName, SiteType, and GroupType
    const relevance = `((name of it as string | "N/A") & "||" & (name of site of it as string | "N/A") & "||" & (if (custom site flag of site of it) then "custom" else if (operator site flag of site of it) then "operator" else if (name of site of it as lowercase = "actionsite" or name of site of it as lowercase = "master action site") then "master" else "external") & "||" & (if automatic flag of it then "Automatic" else if manual flag of it then "Manual" else "ServerBased")) of bes computer groups whose (id of it as string = "${escapeXML(groupId)}")`;
    
    const response = await axios.get(`${bfUrl}/api/query?output=json&relevance=${encodeURIComponent(relevance)}`, { ...bfAuthOpts, headers: { Accept: "application/json" }});
    const result = response.data?.result;
    const val = Array.isArray(result) ? result[0] : result;
    if (!val) throw new Error(`Group ${groupId} not found.`);

    const [groupName, rawSiteName, siteType, groupType] = String(val).split("||");

    // Clean up site name so it cleanly inserts into the REST API URL endpoint
    let cleanSiteName = rawSiteName.trim();
    if (siteType === "custom" && cleanSiteName.toLowerCase().startsWith("customsite_")) {
        cleanSiteName = cleanSiteName.substring(11);
    } else if (siteType === "operator" && cleanSiteName.toLowerCase().startsWith("actionsite_")) {
        cleanSiteName = cleanSiteName.substring(11);
    } else if (cleanSiteName.toLowerCase() === "actionsite" || cleanSiteName.toLowerCase() === "master action site") {
         cleanSiteName = "master"; // Safety fallback mapped to master
    }

    return { 
        siteType: siteType.trim(), 
        siteName: cleanSiteName,
        groupName: groupName.trim(),
        groupType: groupType.trim()
    };
}

function attachGroupUpdateRoutes(app, ctx) {
    const log = logFactory(ctx.DEBUG_LOG);
    const { BIGFIX_BASE_URL } = ctx.bigfix;

    // GET details of a specific group to populate the Edit UI
    app.get("/api/groups/:id/details", async (req, res) => {
        try {
            const { id } = req.params;
            const bfAuthOpts = await getBfAuthContext(req, ctx);
            const loc = await getGroupSiteLocation(req, ctx, id);
            
            let endpoint = `/api/computergroup/${loc.siteType}`;
            if (loc.siteType === "custom" || loc.siteType === "operator") endpoint += `/${encodeURIComponent(loc.siteName)}`;
            endpoint += `/${id}`;

            const url = joinUrl(BIGFIX_BASE_URL, endpoint);
            const resp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/xml" } });
            
            const parser = new xml2js.Parser({ explicitArray: false });
            const parsed = await parser.parseStringPromise(resp.data);
            
            let groupData = { id, siteType: loc.siteType, siteName: loc.siteName, conditions: [], computerIds: [] };

            if (parsed.BESAPI?.ManualComputerGroup) {
                groupData.type = "Manual";
                groupData.name = parsed.BESAPI.ManualComputerGroup.Name;
                const comps = parsed.BESAPI.ManualComputerGroup.ComputerID;
                if (comps) groupData.computerIds = Array.isArray(comps) ? comps : [comps];
            } else if (parsed.BESAPI?.ServerBasedGroup) {
                groupData.type = "ServerBased";
                groupData.name = parsed.BESAPI.ServerBasedGroup.Name;
                
                
                const rulesBlock = parsed.BESAPI.ServerBasedGroup.MembershipRules;
                groupData.logic = rulesBlock?.$?.JoinByIntersection === "false" ? "Any" : "All";
                
                const rules = rulesBlock?.MembershipRule;
                if (rules) {
                    const rulesArr = Array.isArray(rules) ? rules : [rules];
                    groupData.conditions = rulesArr.map(r => ({ propertyId: r.PropertyID, operator: r.$.Comparison, value: r.SearchText }));
                }
            } else if (parsed.BES?.ComputerGroup) {
                groupData.type = "Automatic";
                groupData.name = parsed.BES.ComputerGroup.Title;
                
               
                groupData.logic = parsed.BES.ComputerGroup.JoinByIntersection === "false" ? "Any" : "All";

                const searchComps = parsed.BES.ComputerGroup.SearchComponentPropertyReference;
                if (searchComps) {
                    const compArr = Array.isArray(searchComps) ? searchComps : [searchComps];
                    groupData.conditions = compArr.map(c => ({ property: c.$.PropertyName, operator: c.$.Comparison, value: c.SearchText }));
                }
            } else {
                throw new Error("Unknown group XML format");
            }

            res.json({ ok: true, groupData });
        } catch (e) {
            log(req, "[Groups Update] Fetch Details Failed", e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // PUT route to completely override the existing group
    app.put("/api/groups/:id", async (req, res) => {
        try {
            const { id } = req.params;
            
            const { name, type, conditions, computerIds, logic } = req.body; 
            const isIntersection = logic === "Any" ? "false" : "true";

            const bfAuthOpts = await getBfAuthContext(req, ctx);
            
            const loc = await getGroupSiteLocation(req, ctx, id);
            let endpoint = `/api/computergroup/${loc.siteType}`;
            if (loc.siteType === "custom" || loc.siteType === "operator") endpoint += `/${encodeURIComponent(loc.siteName)}`;
            endpoint += `/${id}`;

            let xmlBody = "";

            if (type === "Manual") {
                const computerTags = (computerIds || []).map(cid => `<ComputerID>${cid}</ComputerID>`).join("");
                xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ManualComputerGroup><Name>${escapeXML(name)}</Name><EvaluateOnClient>false</EvaluateOnClient>${computerTags}</ManualComputerGroup></BESAPI>`;
            } else if (type === "Automatic") {
                const searchComponents = (conditions || []).map(cond => `<SearchComponentPropertyReference PropertyName="${escapeXML(cond.property)}" Comparison="${escapeXML(cond.operator)}"><SearchText>${escapeXML(cond.value)}</SearchText><Relevance></Relevance></SearchComponentPropertyReference>`).join("");
                
                
                xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BES xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BES.xsd"><ComputerGroup><Title>${escapeXML(name)}</Title><JoinByIntersection>${isIntersection}</JoinByIntersection>${searchComponents}</ComputerGroup></BES>`;
            } else if (type === "ServerBased") {
                let searchComponents = "";
                for (const cond of (conditions || [])) {
                    // 🚀 Resolves PropertyID for ServerBased
                    let pid = await getPropertyIdByName(req, ctx, cond.property || cond.propertyId);
                    if (!pid) pid = cond.propertyId || cond.property; 
                    if (!pid) throw new Error(`Could not resolve BigFix Property ID for '${cond.property || cond.propertyId}'.`);

                    searchComponents += `<MembershipRule Comparison="${escapeXML(cond.operator)}"><PropertyID>${escapeXML(pid)}</PropertyID><SearchText>${escapeXML(cond.value)}</SearchText></MembershipRule>`;
                }
                
                
                xmlBody = `<?xml version="1.0" encoding="UTF-8"?><BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd"><ServerBasedGroup><Name>${escapeXML(name)}</Name><MembershipRules JoinByIntersection="${isIntersection}">${searchComponents}</MembershipRules></ServerBasedGroup></BESAPI>`;
            }

            const putUrl = joinUrl(BIGFIX_BASE_URL, endpoint);
            await axios.put(putUrl, xmlBody, { ...bfAuthOpts, headers: { ...bfAuthOpts.headers, "Content-Type": "application/xml" } });

            res.json({ ok: true });
        } catch (e) {
            log(req, `[Groups Update] Update Failed for ${req.params.id}`, e.message);
            res.status(500).json({ ok: false, error: e.response?.data || e.message });
        }
    });
}

module.exports = { attachGroupUpdateRoutes };
// src/routes/roles.js
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { sql, getPool } = require('../db/mssql');
const { getBfAuthContext, joinUrl } = require('../utils/http');

router.use(express.json());

function isAdmin(req) {
  if (!req.cookies?.auth_session) return false;
  try { return JSON.parse(req.cookies.auth_session).role === 'Admin'; } catch { return false; }
}

const xmlEscape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const propToRelevanceMap = {
    "bes relay selection method": 'relay selection method of client',
    "computer name": 'computer name',
    "os": 'operating system',
    "cpu": 'cpu',
    "last report time": 'last report time of client',
    "locked": 'locked flag of action lock state',
    "relay": 'relay server of client',
    "user name": 'user name of current user',
    "ram": 'ram',
    "free space on system drive": 'free space of drive of system folder',
    "total size of system drive": 'total space of drive of system folder',
    "subnet address": 'subnet addresses of ip interfaces of network',
    "active directory path": 'active directory path of client'
};

// 1. Fetch ALL Roles natively from BigFix and merge with local DB
router.get('/api/roles', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        
        const url = joinUrl(BIGFIX_BASE_URL, "/api/roles");
        const bfResp = await axios.get(url, { ...bfAuthOpts, headers: { Accept: "application/xml" }, validateStatus: () => true });
        
        let bfRoles = [];
        if (bfResp.status === 200) {
            const xmlData = String(bfResp.data || "");
            const roleBlocks = xmlData.split("</Role>");
            for (const block of roleBlocks) {
                const idMatch = block.match(/<ID>(\d+)<\/ID>/i);
                const nameMatch = block.match(/<Name>(.*?)<\/Name>/i);
                if (idMatch && nameMatch) {
                    bfRoles.push({
                        BigFixRoleID: parseInt(idMatch[1], 10),
                        Name: nameMatch[1].trim()
                    });
                }
            }
        }

        const pool = await getPool();
        const rs = await pool.request().query('SELECT * FROM dbo.BES_ROLES');
        const dbRolesMap = {};
        rs.recordset.forEach(r => dbRolesMap[r.BigFixRoleID] = r);

        const finalRoles = bfRoles.map(bfr => {
            const dbInfo = dbRolesMap[bfr.BigFixRoleID] || {};
            return {
                RoleID: dbInfo.RoleID || bfr.BigFixRoleID,
                BigFixRoleID: bfr.BigFixRoleID,
                Name: bfr.Name,
                Description: dbInfo.Description || "—",
                CreatedBy: dbInfo.CreatedBy || "BigFix Console",
                CreatedAt: dbInfo.CreatedAt || new Date().toISOString()
            };
        });

        finalRoles.sort((a, b) => new Date(b.CreatedAt) - new Date(a.CreatedAt));
        res.json({ ok: true, roles: finalRoles });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/roles/check-operator/:username', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        const url = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(req.params.username)}`);
        try {
            const resp = await axios.get(url, { ...bfAuthOpts, timeout: 10000 });
            res.json({ ok: true, exists: resp.status === 200 });
        } catch (err) {
            if (err.response && err.response.status === 404) { res.json({ ok: true, exists: false }); } 
            else { throw err; }
        }
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/roles/properties', async (req, res) => {
    try {
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        
        const allowed = [
            "BES Relay Selection Method", "Computer Name", "OS", "CPU", 
            "Last Report Time", "Locked", "Relay", "User Name", "RAM", 
            "Free Space on System Drive", "Total Size of System Drive", 
            "Subnet Address", "Active Directory Path"
        ];
        
        const url = joinUrl(BIGFIX_BASE_URL, "/api/properties");
        const resp = await axios.get(url, { ...bfAuthOpts, timeout: 15000 });
        const xml = String(resp.data);
        
        const propMap = {};
        const matches = xml.matchAll(/<Property Resource="([^"]+)">[\s\S]*?<Name>([^<]+)<\/Name>/gi);
        
        for (const m of matches) {
            const resource = m[1];
            const name = m[2];
            const lowerName = name.toLowerCase();
            
            if (allowed.some(a => a.toLowerCase() === lowerName)) {
                if (!propMap[lowerName] || resource.length < propMap[lowerName].resource.length) {
                    propMap[lowerName] = { name: name, resource: resource };
                }
            }
        }

        const properties = allowed.map(a => {
            return propMap[a.toLowerCase()] || { name: a, resource: "" };
        }).sort((a,b) => a.name.localeCompare(b.name));

        res.json({ ok: true, properties });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/roles/property-values-filtered', async (req, res) => {
    try {
        const { targetProp, filters } = req.body;
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;

        let compFilter = "bes computers";
        if (filters && filters.length > 0) {
            const conds = filters.map(f => {
                const prop = String(f.prop).replace(/"/g, '""').toLowerCase().trim();
                const val = String(f.val).replace(/"/g, '""').toLowerCase().trim();
                return `exists values whose(it as string as lowercase = "${val}") of results(it, bes property "${prop}")`;
            }).join(" and ");
            compFilter = `bes computers whose (${conds})`;
        }

        const safeTarget = String(targetProp).replace(/"/g, '""').toLowerCase().trim();
        const relevance = `(it & "||" & multiplicity of it as string) of unique values of (it as string) whose(it != "") of values of results (bes property "${safeTarget}", ${compFilter})`;

        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relevance)}`;
        const resp = await axios.get(url, { ...bfAuthOpts, timeout: 15000 });

        let valuesRaw = resp.data?.result || [];
        if (!Array.isArray(valuesRaw)) valuesRaw = [valuesRaw];

        const values = valuesRaw.map(r => {
            const parts = String(r).split("||");
            return { value: parts[0], count: parseInt(parts[1]) || 0 };
        }).sort((a, b) => a.value.localeCompare(b.value));

        res.json({ ok: true, values });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/roles/computers/count', async (req, res) => {
    try {
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        const url = `${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent("number of bes computers")}`;
        const resp = await axios.get(url, { ...bfAuthOpts, timeout: 15000 });
        res.json({ ok: true, total: resp.data?.result || 0 });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/roles/sites', async (req, res) => {
    try {
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        
        const relCustom = `( (display name of it | "N/A") & "||Custom||" & (name of it) ) of bes custom sites`;
        const relExternal = `( (display name of it | "N/A") & "||External||" & (name of it) ) of bes sites whose(external site flag of it and (display name of it as lowercase contains "patche" or display name of it as lowercase contains "update"))`;
        
        const [respC, respE] = await Promise.all([
            axios.get(`${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relCustom)}`, { ...bfAuthOpts, timeout: 15000 }),
            axios.get(`${joinUrl(BIGFIX_BASE_URL, "/api/query")}?output=json&relevance=${encodeURIComponent(relExternal)}`, { ...bfAuthOpts, timeout: 15000 })
        ]);
        
        let customRes = respC.data?.result || [];
        if (!Array.isArray(customRes)) customRes = [customRes];
        
        let extRes = respE.data?.result || [];
        if (!Array.isArray(extRes)) extRes = [extRes];

        const sites = [...customRes, ...extRes].map(r => {
            const p = String(r).split("||");
            return { name: p[2].trim(), url: p[2].trim(), type: p[1].trim(), creator: "N/A" }; 
        }).sort((a,b) => a.name.localeCompare(b.name));
        
        res.json({ ok: true, sites });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function parseRoleXml(xml) {
    const extract = (tag) => {
        const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m ? m[1].trim() : "";
    };

    const details = {
        name: extract("Name"),
        description: extract("Description"),
        perms: {
            masterOperator: extract("MasterOperator"),
            customContent: extract("CustomContent"),
            showOtherActions: extract("ShowOtherActions"),
            stopOtherActions: extract("StopOtherActions"),
            canCreateActions: extract("CanCreateActions"),
            postActionBehavior: extract("PostActionBehaviorPrivilege"),
            actionScriptCommands: extract("ActionScriptCommandsPrivilege"),
            canSendRefresh: extract("CanSendMultipleRefresh"),
            canSubmitQueries: extract("CanSubmitQueries"),
            canLock: extract("CanLock"),
            unmanagedAssets: extract("UnmanagedAssetPrivilege"),
            useConsole: xml.match(/<Console>(.*?)<\/Console>/i)?.[1] || "false",
            useWebUI: xml.match(/<WebUI>(.*?)<\/WebUI>/i)?.[1] || "false",
            useRESTAPI: xml.match(/<API>(.*?)<\/API>/i)?.[1] || "false",
        },
        computers: [],
        sites: [],
        operators: []
    };

    const compMatches = xml.matchAll(/<Property Name="([^"]+)"(?:.*?Resource="([^"]*)")?[\s\S]*?<Value>([^<]+)<\/Value>/g);
    for (const match of compMatches) details.computers.push({ property: match[1], resource: match[2] || "", value: decodeURIComponent(match[3]) });

    const groupMatches = xml.matchAll(/<ComputerGroup>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/ComputerGroup>/g);
    for (const match of groupMatches) details.computers.push({ property: 'Group', resource: 'GroupResource', value: match[1] });

    const siteMatches = xml.matchAll(/<(ExternalSite|CustomSite)>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<Permission>([^<]+)<\/Permission>[\s\S]*?<\/\1>/g);
    for (const match of siteMatches) details.sites.push({ type: match[1] === "CustomSite" ? "Custom" : "External", name: match[2], url: match[2], permission: match[3] });

    const opMatches = xml.matchAll(/<Operator>([^<]+)<\/Operator>|<Explicit>([^<]+)<\/Explicit>/g);
    for (const match of opMatches) details.operators.push(match[1] || match[2]);

    return details;
}

function buildRoleXml(data) {
    let compXml = "";
    if (data.computers && data.computers.length > 0) {
        const conds = data.computers.map(c => {
            if (c.property === 'Group') {
                return `\n<ComputerGroup>\n<Name>${xmlEscape(c.value)}</Name>\n</ComputerGroup>`;
            } else {
                const relExpr = propToRelevanceMap[String(c.property).toLowerCase()];
                const relTag = relExpr ? `\n<Relevance>exists ((${relExpr}) as string) whose (it = "${xmlEscape(c.value)}")</Relevance>` : "";
                return `\n<ByRetrievedProperties Match="All">\n<Property Name="${xmlEscape(c.property)}" Resource="${xmlEscape(c.resource || "")}">\n<Value>${encodeURIComponent(c.value).replace(/\(/g, '%28').replace(/\)/g, '%29')}</Value>\n</Property>${relTag}\n</ByRetrievedProperties>`;
            }
        }).join("");
        compXml = `\n<ComputerAssignments>${conds}\n</ComputerAssignments>`;
    }

    let siteXml = "";
    if (data.sites && data.sites.length > 0) {
        const siteElements = data.sites.map(s => {
            const tag = s.type === 'Custom' ? 'CustomSite' : 'ExternalSite';
            const perm = s.type === 'External' ? 'Reader' : (s.permission || 'Reader'); 
            return `<${tag}>\n<Name>${xmlEscape(s.name)}</Name>\n<Permission>${xmlEscape(perm)}</Permission>\n</${tag}>`;
        }).join("");
        siteXml = `\n<Sites>\n${siteElements}\n</Sites>`;
    }

    let opXml = "";
    if (data.operators && data.operators.length > 0) {
        const opElements = data.operators.map(op => `<Explicit>${xmlEscape(op)}</Explicit>`).join("\n");
        opXml = `\n<Operators>\n${opElements}\n</Operators>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
    <BESAPI xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BESAPI.xsd">
        <Role>
            <Name>${xmlEscape(data.name)}</Name>
            <Description>${xmlEscape(data.description)}</Description>
            <MasterOperator>${data.perms.masterOperator || '0'}</MasterOperator>
            <CustomContent>${data.perms.customContent || '0'}</CustomContent>
            <ShowOtherActions>${data.perms.showOtherActions || '0'}</ShowOtherActions>
            <StopOtherActions>${data.perms.stopOtherActions || '0'}</StopOtherActions>
            <CanCreateActions>${data.perms.canCreateActions || '0'}</CanCreateActions>
            <PostActionBehaviorPrivilege>${data.perms.postActionBehavior || 'AllowRestartOnly'}</PostActionBehaviorPrivilege>
            <ActionScriptCommandsPrivilege>${data.perms.actionScriptCommands || 'AllowRestartOnly'}</ActionScriptCommandsPrivilege>
            <CanSendMultipleRefresh>${data.perms.canSendRefresh || '0'}</CanSendMultipleRefresh>
            <CanSubmitQueries>${data.perms.canSubmitQueries || '0'}</CanSubmitQueries>
            <CanLock>${data.perms.canLock || '0'}</CanLock>
            <UnmanagedAssetPrivilege>${data.perms.unmanagedAssets || 'ShowNone'}</UnmanagedAssetPrivilege>
            <InterfaceLogins>
                <Console>${data.perms.useConsole || 'false'}</Console>
                <WebUI>${data.perms.useWebUI || 'false'}</WebUI>
                <API>${data.perms.useRESTAPI || 'false'}</API>
            </InterfaceLogins>${opXml}${siteXml}${compXml}
        </Role>
    </BESAPI>`;
}

router.post('/api/roles/create', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
        const { name, description, perms, computers, sites, operators } = req.body;
        if (!name) return res.status(400).json({ ok: false, error: 'Role name required' });
        
        const xml = buildRoleXml({ name, description, perms, computers, sites, operators });
        const creator = req.headers['x-active-user'] || 'Admin';

        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        const postUrl = joinUrl(BIGFIX_BASE_URL, "/api/roles");
        
        const bfResp = await axios.post(postUrl, xml, { ...bfAuthOpts, timeout: 20000, headers: { "Content-Type": "application/xml" }});
        
        let newId = null;
        const idMatch = String(bfResp.data).match(/<ID>(\d+)<\/ID>/i);
        if (idMatch) newId = parseInt(idMatch[1], 10);

        const pool = await getPool();
        await pool.request()
            .input('Name', sql.NVarChar(255), name)
            .input('Desc', sql.NVarChar(sql.MAX), description || "")
            .input('BFID', sql.Int, newId || null)
            .input('Creator', sql.NVarChar(128), creator)
            .query(`INSERT INTO dbo.BES_ROLES (Name, Description, BigFixRoleID, CreatedBy, CreatedAt) VALUES (@Name, @Desc, @BFID, @Creator, SYSUTCDATETIME())`);

        res.json({ ok: true, roleId: newId, message: "Role created successfully." });
    } catch (e) {
        console.error("Create Role Error:", e);
        const bfErr = e.response?.data ? String(e.response.data) : e.message;
        res.status(500).json({ ok: false, error: `BigFix API Error: ${bfErr.substring(0, 300)}` });
    }
});

router.get('/api/roles/:id/details', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        const url = joinUrl(BIGFIX_BASE_URL, `/api/role/${req.params.id}`);

        const resp = await axios.get(url, { ...bfAuthOpts, timeout: 15000 });
        const details = parseRoleXml(String(resp.data));

        res.json({ ok: true, details });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.put('/api/roles/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
        const { details, perms, computers, sites, operators } = req.body;
        const bfAuthOpts = await getBfAuthContext(req, req.app.locals.ctx);
        const { BIGFIX_BASE_URL } = req.app.locals.ctx.bigfix;
        const url = joinUrl(BIGFIX_BASE_URL, `/api/role/${req.params.id}`);

        const resp = await axios.get(url, { ...bfAuthOpts, timeout: 15000 });
        const existingData = parseRoleXml(String(resp.data));

        if (details) {
            existingData.name = details.name;
            existingData.description = details.description;
        }
        if (perms) existingData.perms = { ...existingData.perms, ...perms };
        if (computers) existingData.computers = computers;
        if (sites) existingData.sites = sites;
        if (operators) existingData.operators = operators;

        const newXml = buildRoleXml(existingData);

        await axios.put(url, newXml, { ...bfAuthOpts, timeout: 20000, headers: { "Content-Type": "application/xml" }});

        if (details) {
            const pool = await getPool();
            await pool.request()
                .input('Name', sql.NVarChar(255), details.name)
                .input('Desc', sql.NVarChar(sql.MAX), details.description || "")
                .input('BFID', sql.Int, parseInt(req.params.id))
                .query(`UPDATE dbo.BES_ROLES SET Name=@Name, Description=@Desc WHERE BigFixRoleID=@BFID`);
        }

        res.json({ ok: true, message: "Role updated successfully." });
    } catch (e) {
        console.error("Update Role Error:", e);
        const bfErr = e.response?.data ? String(e.response.data) : e.message;
        res.status(500).json({ ok: false, error: `BigFix API Error: ${bfErr.substring(0, 300)}` });
    }
});

function attachRoleRoutes(app, ctx) {
    app.locals.ctx = ctx; 
    app.use(router);
}

module.exports = { attachRoleRoutes };
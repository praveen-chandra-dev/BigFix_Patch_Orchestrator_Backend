// src/services/bigfix/assignRole.js
const axios = require('axios');
const { getCtx } = require('../../env');
const { joinUrl } = require('../../utils/http');
const { logger } = require('../logger');

// Returns { ok:boolean, reason:string }.
// (Existing callers `await assignRole(...)` without inspecting the return value,
//  so returning an object instead of a bare boolean is backward-compatible.)
async function assignRole(username, roleName) {
    if (!roleName || roleName === 'Admin') return { ok: true, reason: 'admin/no-op' };

    const ctx = getCtx();
    const { BIGFIX_BASE_URL, BIGFIX_USER, BIGFIX_PASS, httpsAgent } = ctx.bigfix;
    if (!BIGFIX_BASE_URL) return { ok: false, reason: 'BigFix not configured' };

    const auth = { username: BIGFIX_USER, password: BIGFIX_PASS };

    try {
        // 1) Resolve the role ID from the role list.
        const rolesUrl = joinUrl(BIGFIX_BASE_URL, `/api/roles`);
        const rolesResp = await axios.get(rolesUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });

        let roleId = null;
        if (rolesResp.status === 200) {
            const xmlData = String(rolesResp.data || "");
            const roleBlocks = xmlData.split("</Role>");
            for (const block of roleBlocks) {
                if (block.includes(`<Name>${roleName}</Name>`) || block.includes(`>${roleName}<`)) {
                    const idMatch = block.match(/<ID>(\d+)<\/ID>/i);
                    if (idMatch) { roleId = idMatch[1]; break; }
                }
            }
        }
        if (!roleId) {
            return { ok: false, reason: `Role '${roleName}' not found in BigFix (/api/roles -> HTTP ${rolesResp.status})` };
        }

        // 2) Fetch the role definition.
        const roleUrl = joinUrl(BIGFIX_BASE_URL, `/api/role/${roleId}`);
        const roleResp = await axios.get(roleUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        if (roleResp.status !== 200) {
            return { ok: false, reason: `Could not read role '${roleName}' (GET /api/role/${roleId} -> HTTP ${roleResp.status})` };
        }

        let roleXml = String(roleResp.data);
        const explicitTag = `<Explicit>${username}</Explicit>`;
        if (new RegExp(`<Explicit>\\s*${username}\\s*</Explicit>`, 'i').test(roleXml)) {
            return { ok: true, reason: 'already assigned' };
        }

        // 3) Insert the operator, preserving BigFix's Role schema element order.
        roleXml = roleXml.replace(/<Operators\s*\/>/gi, '');
        if (/<Operators>/i.test(roleXml)) {
            roleXml = roleXml.replace(/<Operators>/i, `<Operators>\n${explicitTag}`);
        } else {
            // BESAPI Role is a strict ordered sequence and <Operators> sits
            // IMMEDIATELY after <InterfaceLogins> and before
            // Sites/ComputerAssignments/LDAP/Domain membership. Every role has an
            // <InterfaceLogins> block, so anchor on its close tag — that is the one
            // position BigFix accepts. (The EUC role had InterfaceLogins +
            // ComputerAssignments but no Operators/Sites; appending before </Role>
            // put Operators after ComputerAssignments -> HTTP 400.)
            const operatorsBlock = `<Operators>\n${explicitTag}\n</Operators>\n`;
            if (/<\/InterfaceLogins>/i.test(roleXml)) {
                roleXml = roleXml.replace(/<\/InterfaceLogins>/i, `</InterfaceLogins>\n${operatorsBlock}`);
            } else {
                // Fallback for a role with no login block: insert before the first
                // element that must follow Operators.
                const anchor = /<(Sites|ComputerAssignments|LDAPGroups|LDAPOperators|DomainOperators)\b/i.exec(roleXml);
                if (anchor) {
                    roleXml = roleXml.slice(0, anchor.index) + operatorsBlock + roleXml.slice(anchor.index);
                } else {
                    roleXml = roleXml.replace(/<\/Role>/i, `${operatorsBlock}</Role>`);
                }
            }
        }

        // 4) Write it back and CHECK the HTTP result (don't assume success).
        const putResp = await axios.put(roleUrl, roleXml, { httpsAgent, auth, headers: { "Content-Type": "application/xml" }, validateStatus: () => true });
        if (putResp.status < 200 || putResp.status >= 300) {
            logger.warn(`[RBAC] PUT /api/role/${roleId} ('${roleName}') -> HTTP ${putResp.status}: ${String(putResp.data || '').slice(0, 300)}`);
            return { ok: false, reason: `BigFix rejected the role update (HTTP ${putResp.status})` };
        }

        // 5) Verify the operator is actually a member now (source of truth).
        const verifyUrl = joinUrl(BIGFIX_BASE_URL, `/api/operator/${encodeURIComponent(username)}/roles`);
        const verifyResp = await axios.get(verifyUrl, { httpsAgent, auth, headers: { Accept: "application/xml" }, validateStatus: () => true });
        if (verifyResp.status === 200 && String(verifyResp.data || '').includes(`<Name>${roleName}</Name>`)) {
            return { ok: true, reason: 'assigned' };
        }
        logger.warn(`[RBAC] '${username}' not reflected in role '${roleName}' after PUT (verify HTTP ${verifyResp.status})`);
        return { ok: false, reason: `Update was accepted but '${roleName}' is not reflected on the operator afterwards` };
    } catch (err) {
        logger.warn(`[RBAC] Failed to assign '${username}' to '${roleName}': ${err.message}`);
        return { ok: false, reason: err.message };
    }
}

module.exports = assignRole;
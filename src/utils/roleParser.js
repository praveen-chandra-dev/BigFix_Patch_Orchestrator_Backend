function parseRoleXml(xml) {
    const extract = (tag) => {
        const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m ? m[1].trim() : "";
    };

    const details = {
        name: extract("Name"),
        description: extract("Description"),
        perms: {},
        computers: [],
        sites: [],
        operators: []
    };

    const siteMatches = xml.matchAll(/<(ExternalSite|CustomSite)>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<Permission>([^<]+)<\/Permission>[\s\S]*?<\/\1>/g);

    for (const match of siteMatches) {
        details.sites.push({
            type: match[1] === "CustomSite" ? "Custom" : "External",
            name: match[2],
            permission: match[3]
        });
    }

    return details;
}

module.exports = { parseRoleXml };
const { getPatches } = require("./prism");
const { setCache, getCache, withCacheLock } = require("./prismCache");
const { getAllowedSites } = require("./roleService");

const warmedUsers = new Set();

async function warmUserCache(username, ctx) {
    try {


        if (!username) return;

        // prevent duplicate warmups
        if (warmedUsers.has(username)) {
            return;
        }

        console.log(`[Warmup] Starting for user: ${username}`);

        /* =========================
           PATCH CACHE
        ========================= */
        let patches = getCache("patches");

        if (!patches) {
            patches = await withCacheLock("patches_fetch", async () => {
                const fresh = await getPatches();

                if (Array.isArray(fresh) && fresh.length > 0) {
                    setCache("patches", fresh);
                }

                return fresh;
            });
        }

        /* =========================
           RBAC CACHE
        ========================= */
        const sites = await getAllowedSites(
            { headers: { "x-active-user": username } },
            ctx
        );

        console.log(`[Warmup] Cached ${patches?.length || 0} patches`);
        console.log(`[Warmup] Cached RBAC sites: ${sites.length}`);

        warmedUsers.add(username);

    } catch (e) {
        console.error("[Warmup] Failed:", e.message);
    }
}

module.exports = { warmUserCache };
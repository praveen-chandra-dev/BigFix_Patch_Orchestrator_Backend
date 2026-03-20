const axios = require("axios");
const https = require("https");
const { getCtx } = require("../env");

let cachedToken = null;
let tokenExpiry = null;
let tokenPromise = null;

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return {};
  }
}

function isTokenExpired() {
  if (!cachedToken || !tokenExpiry) return true;
  const now = Math.floor(Date.now() / 1000);
  return now >= tokenExpiry - 60; // Refresh 60s before expiry
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && !isTokenExpired()) {
    return cachedToken;
  }

  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    try {
      const ctx = getCtx();

      const response = await axios.post(
        `${ctx.prism.PRISM_BASE_URL}/api/v1/auth/token`,
        {
          username: ctx.prism.PRISM_USER,
          password: ctx.prism.PRISM_PASS,
        },
        { httpsAgent }
      );

      cachedToken = response.data.access_token;

      const decoded = decodeJwt(cachedToken);
      tokenExpiry = decoded.exp;

      console.log(
        `Prism token refreshed. Expires at: ${new Date(
          tokenExpiry * 1000
        ).toISOString()}`
      );

      return cachedToken;
    } catch (error) {
      console.error("Token fetch failed:", error.message);
      throw new Error("Failed to authenticate with Prism API");
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

async function prismRequest(config, retry = true) {
  try {
    const token = await getToken();
    const response = await axios({
      ...config,
      httpsAgent,
      timeout: 15000,
      headers: {
        ...(config.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    return response;
  } catch (error) {
    if (!error.response && retry) {
      console.log("Retrying request...");
      return prismRequest(config, false);
    }
    throw error;
  }
}

async function getPatches() {
  try {
    const ctx = getCtx();

    const first = await prismRequest({
      method: "GET",
      url: `${ctx.prism.PRISM_BASE_URL}/api/v1/patches`,
      params: { page: 1, limit: 100 },
    });

    let allPatches = [...first.data.data];
    const totalPages = first.data.pagination.total_pages;

    if (totalPages > 1) {
      const requests = [];

      for (let page = 2; page <= totalPages; page++) {
        requests.push(
          prismRequest({
            method: "GET",
            url: `${ctx.prism.PRISM_BASE_URL}/api/v1/patches`,
            params: { page, limit: 100 },
          })
        );
      }

      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        allPatches.push(...res.data.data);
      });
    }

    return allPatches.map((p) => ({
      ...p,
      applicable_computers: safeParse(p.applicable_computers),
      final_score: p.final_score != null ? Number(p.final_score) : null,
      status: p.status ?? 0,
    }));
  } catch (error) {
    console.error("Patch fetch failed:", error.message);
    throw new Error("Failed to fetch patches from Prism API");
  }
}

function safeParse(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

module.exports = {
  getToken,
  prismRequest,
  getPatches
};
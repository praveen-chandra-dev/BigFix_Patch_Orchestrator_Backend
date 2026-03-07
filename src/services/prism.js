const axios = require("axios");
const https = require("https");

let cachedToken = null;
let tokenExpiry = null;

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

function decodeJwt(token) {
  const payload = token.split(".")[1];
  const decoded = Buffer.from(payload, "base64").toString("utf8");
  return JSON.parse(decoded);
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
  try {
    const response = await axios.post(
      `${process.env.PRISM_BASE_URL}/api/v1/auth/token`,
      {
        username: process.env.PRISM_USER,
        password: process.env.PRISM_PASS,
      },
      { httpsAgent }
    );
    cachedToken = response.data.access_token;
    const decoded = decodeJwt(cachedToken);
    tokenExpiry = decoded.exp;
    console.log(`Prism token refreshed. Expires at: ${new Date(tokenExpiry * 1000).toISOString()}`);
    return cachedToken;
  } catch (error) {
    console.error("Token fetch failed:", error.message);
    throw new Error("Failed to authenticate with Prism API");
  }
}

async function prismRequest(config, retry = true) {
  try {
    const token = await getToken();
    const response = await axios({
      ...config,
      httpsAgent,
      headers: {
        ...(config.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    return response;
  } catch (error) {
    if (error.response && error.response.status === 401 && retry) {
      console.log("401 detected. Forcing token refresh...");
      cachedToken = null;
      tokenExpiry = null;
      await getToken(true);
      return prismRequest(config, false);
    }
    throw error;
  }
}

async function getPatches() {
  try {
    let page = 1;
    let totalPages = 1;
    let allPatches = [];

    while (page <= totalPages) {
      const response = await prismRequest({
        method: "GET",
        url: `${process.env.PRISM_BASE_URL}/api/v1/patches`,
        params: { page, limit: 100 },
      });
      const data = response.data.data;
      const pagination = response.data.pagination;
      allPatches = [...allPatches, ...data];
      totalPages = pagination.total_pages;
      page++;
    }
    return allPatches.map((p) => ({
      ...p,
      applicable_computers: safeParse(p.applicable_computers),
      final_score: Number(p.final_score || 0),
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
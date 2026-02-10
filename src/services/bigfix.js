// bigfix-backend/src/services/bigfix.js
const axios = require("axios");
const https = require("https");
const { collectStrings } = require("../utils/query");

const bigfixClient = (ctx) => {
  // 1. Extract Config
  const config = ctx.bigfix || {};
  const BIGFIX_BASE_URL = config.BIGFIX_BASE_URL || process.env.BIGFIX_BASE_URL;
  const BIGFIX_USER = config.BIGFIX_USER || process.env.BIGFIX_USER;
  const BIGFIX_PASS = config.BIGFIX_PASS || process.env.BIGFIX_PASS;
  
  const allowSelfSigned = String(config.BIGFIX_ALLOW_SELF_SIGNED || process.env.BIGFIX_ALLOW_SELF_SIGNED).toLowerCase() === "true";

  if (!BIGFIX_BASE_URL) throw new Error("BigFix URL not configured");

  // 2. Create HTTPS Agent
  const httpsAgent = new https.Agent({ 
    rejectUnauthorized: !allowSelfSigned 
  });

  // 3. Create Axios Client
  const client = axios.create({
    baseURL: BIGFIX_BASE_URL,
    auth: { username: BIGFIX_USER, password: BIGFIX_PASS },
    httpsAgent,
    timeout: 30000
  });

  async function getGroupMembers(groupName) {
    // Relevance: Get (Name, IPs, OS) for all computers in the specified group
    // Added 'operating system of it' to the tuple
    const relevance = `(name of it, (value of result (it, bes property "Patch_Setu_IP_Address") | "N/A"), (operating system of it | "Unknown")) of members whose (value of result (it, bes property "Device Type") as lowercase = "server") of bes computer group whose (name of it = "${groupName}")`;
    
    try {
      const res = await client.get("/api/query", {
        params: { output: "json", relevance }
      });

      const rows = res.data?.result || [];
      return rows.map(r => {
        // Result format: [ "ComputerName", "10.0.0.1;192.168.1.50", "Win2019" ]
        const parts = [];
        collectStrings(r, parts);
        
        const [name, ipStr, os] = parts;
        
        return {
          name: name || "Unknown",
          // Split IPs string into array
          ips: (ipStr || "").split(";").filter(Boolean),
          os: os || "Unknown" // <--- Now available for filtering
        };
      });
    } catch (err) {
      // Enhanced Error Logging
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`BigFix Group Member Fetch Error for group '${groupName}':`, msg);
      throw new Error(`Failed to fetch members for group ${groupName}: ${msg}`);
    }
  }

  return { getGroupMembers };
};

module.exports = { bigfixClient };
// bigfix-backend/src/services/vcenter.js
const axios = require("axios");
const https = require("https");

const vcenterClient = (ctx) => {
  const config = ctx.servicenow || ctx.vcenter || {};
  const VCENTER_URL = ctx.VCENTER_URL || config.VCENTER_URL || process.env.VCENTER_URL;
  const VCENTER_USER = ctx.VCENTER_USER || config.VCENTER_USER || process.env.VCENTER_USER;
  const VCENTER_PASSWORD = ctx.VCENTER_PASSWORD || config.VCENTER_PASSWORD || process.env.VCENTER_PASSWORD;
  const VCENTER_ALLOW_SELF_SIGNED = ctx.VCENTER_ALLOW_SELF_SIGNED || config.VCENTER_ALLOW_SELF_SIGNED || process.env.VCENTER_ALLOW_SELF_SIGNED;

  if (!VCENTER_URL || !VCENTER_USER || !VCENTER_PASSWORD) {
    throw new Error("VCenter configuration is missing (URL, User, or Password).");
  }

  const host = VCENTER_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const soapBaseUrl = `https://${host}/sdk`;
  const restBaseUrl = `https://${host}/rest`;

  const httpsAgent = new https.Agent({ 
    rejectUnauthorized: String(VCENTER_ALLOW_SELF_SIGNED).toLowerCase() !== "true" 
  });

  const client = axios.create({
    baseURL: soapBaseUrl,
    httpsAgent,
    responseType: 'text',
    validateStatus: (status) => status < 600,
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "urn:vim25/6.0" },
    timeout: 120000 
  });

  const restClient = axios.create({
    baseURL: restBaseUrl,
    httpsAgent,
    headers: { "Content-Type": "application/json" },
    timeout: 30000
  });

  const createEnvelope = (body) => `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:vim25" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
       <soapenv:Header/>
       <soapenv:Body>${body}</soapenv:Body>
    </soapenv:Envelope>
  `;

  // Strict Tag Extraction
  const extractVal = (xml, tag) => {
    if (!xml) return null;
    const regex = new RegExp(`<(?:\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  };

  const postSoap = async (body) => {
    const xml = createEnvelope(body);
    try {
      const res = await client.post("", xml);
      const data = typeof res.data === 'string' ? res.data : String(res.data);
      if (data.includes("Fault>") || data.includes(":Fault>")) {
         const fault = extractVal(data, "faultstring");
         const errMsg = fault || `Unknown SOAP Fault. RAW Response: ${data.substring(0, 300)}...`;
         return { error: errMsg }; 
      }
      return { data };
    } catch (err) {
      throw new Error(`VCenter Connection Failed: ${err.message}`);
    }
  };

  // --- AUTH & SESSION ---
  let loginPromise = null;
  async function connectAndLogin() {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const svcRes = await postSoap(`<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">ServiceInstance</urn:_this></urn:RetrieveServiceContent>`);
      if (svcRes.error) throw new Error(`ServiceContent Error: ${svcRes.error}`);

      const sessionManager = extractVal(svcRes.data, "sessionManager");
      const propertyCollector = extractVal(svcRes.data, "propertyCollector");
      const customizationSpecManager = extractVal(svcRes.data, "customizationSpecManager");
      const searchIndex = extractVal(svcRes.data, "searchIndex");

      if (!sessionManager) throw new Error("Failed to retrieve VCenter ServiceContent");

      let plainPass = VCENTER_PASSWORD;
      try {
        if (/^[A-Za-z0-9+/=]+$/.test(VCENTER_PASSWORD) && VCENTER_PASSWORD.length % 4 === 0) {
           const decoded = Buffer.from(VCENTER_PASSWORD, 'base64').toString('utf-8');
           if (decoded) plainPass = decoded;
        }
      } catch (e) {}

      const safeUser = VCENTER_USER.replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`);
      const safePass = plainPass.replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`);

      const loginRes = await client.post("", createEnvelope(`
        <urn:Login>
           <urn:_this type="SessionManager">${sessionManager}</urn:_this>
           <urn:userName>${safeUser}</urn:userName>
           <urn:password>${safePass}</urn:password>
        </urn:Login>
      `));

      const loginData = String(loginRes.data);
      if (loginData.includes("Fault>")) {
         throw new Error(`VCenter Login Error: ${extractVal(loginData, "faultstring") || "Unknown"}`);
      }

      const cookie = loginRes.headers['set-cookie'];
      client.defaults.headers.Cookie = cookie;

      return { propertyCollector, customizationSpecManager, searchIndex };
    })();
    return loginPromise;
  }

  // --- CLONE HELPERS ---

  async function resolveResourcePool(hostId, propertyCollector) {
    const hostBody = `
      <urn:RetrieveProperties>
        <urn:_this type="PropertyCollector">${propertyCollector}</urn:_this>
        <urn:specSet>
          <urn:propSet><urn:type>HostSystem</urn:type><urn:pathSet>parent</urn:pathSet></urn:propSet>
          <urn:objectSet><urn:obj type="HostSystem">${hostId}</urn:obj></urn:objectSet>
        </urn:specSet>
      </urn:RetrieveProperties>`;
    
    const hostRes = await postSoap(hostBody);
    if (hostRes.error) throw new Error("Failed to resolve Host Parent: " + hostRes.error);

    const parentMatch = hostRes.data.match(/<(?:\w+:)?val[^>]*\s+type="([^"]+)"[^>]*>([^<]+)<\//i) || 
                        hostRes.data.match(/<(?:\w+:)?val[^>]*>([^<]+)<\//i);
    
    if (!parentMatch) throw new Error("Could not find Host Parent in response.");
    
    let parentType, parentId;
    if (parentMatch.length === 3) {
        const rawType = parentMatch[1];
        parentType = rawType.split(':').pop(); 
        parentId = parentMatch[2];
    } else {
        throw new Error("Host Parent Type missing in response attributes.");
    }

    const poolBody = `
      <urn:RetrieveProperties>
        <urn:_this type="PropertyCollector">${propertyCollector}</urn:_this>
        <urn:specSet>
          <urn:propSet><urn:type>${parentType}</urn:type><urn:pathSet>resourcePool</urn:pathSet></urn:propSet>
          <urn:objectSet><urn:obj type="${parentType}">${parentId}</urn:obj></urn:objectSet>
        </urn:specSet>
      </urn:RetrieveProperties>`;

    const poolRes = await postSoap(poolBody);
    if (poolRes.error) throw new Error("Failed to resolve Resource Pool: " + poolRes.error);
    
    const poolId = extractVal(poolRes.data, "val");
    if (!poolId || poolId.includes("<")) throw new Error("Resource Pool ID extraction failed.");
    
    return poolId;
  }

  async function getCustomizationSpec(specName, specManagerId) {
    const body = `
      <urn:GetCustomizationSpec>
        <urn:_this type="CustomizationSpecManager">${specManagerId}</urn:_this>
        <urn:name>${specName}</urn:name>
      </urn:GetCustomizationSpec>`;
    
    const res = await postSoap(body);
    if (res.error) throw new Error(`OS Spec '${specName}' not found or error: ` + res.error);

    const identityMatch = res.data.match(/<identity[^>]*xsi:type="([^"]+)"[^>]*>([\s\S]*?)<\/identity>/);
    if (!identityMatch) throw new Error("Could not parse Identity from Customization Spec.");
    return { type: identityMatch[1], xml: identityMatch[2] };
  }

  async function cloneVm(vmId, cloneName, { folderId, datastoreId, hostId, osSpecName }, { newIp, subnet, gateway, dns }) {
    try {
      const { propertyCollector, customizationSpecManager } = await connectAndLogin();

      const poolId = await resolveResourcePool(hostId, propertyCollector);
      const identity = await getCustomizationSpec(osSpecName, customizationSpecManager);

      const dnsList = (dns || "").split(",").map(d => d.trim()).filter(Boolean);
      const dnsXml = dnsList.map(d => `<dnsServerList>${d}</dnsServerList>`).join("");
      const gwXml = gateway ? `<gateway>${gateway}</gateway>` : "";

      const body = `
        <CloneVM_Task xmlns="urn:vim25">
           <_this type="VirtualMachine">${vmId}</_this>
           <folder type="Folder">${folderId}</folder>
           <name>${cloneName}</name>
           <spec>
               <location>
                   <datastore type="Datastore">${datastoreId}</datastore>
                   <pool type="ResourcePool">${poolId}</pool>
                   <host type="HostSystem">${hostId}</host>
               </location>
               <template>false</template>
               <customization>
                   <identity xsi:type="${identity.type}">${identity.xml}</identity>
                   <globalIPSettings>${dnsXml}</globalIPSettings>
                   <nicSettingMap>
                       <adapter>
                           <ip xsi:type="CustomizationFixedIp">
                               <ipAddress>${newIp}</ipAddress>
                           </ip>
                           <subnetMask>${subnet}</subnetMask>
                           ${gwXml}
                       </adapter>
                   </nicSettingMap>
               </customization>
               <powerOn>true</powerOn>
           </spec>
        </CloneVM_Task>
      `;

      const res = await postSoap(body);
      if (res.error) throw new Error(res.error);

      const taskId = extractVal(res.data, "returnval");
      return { ok: true, taskId };

    } catch (e) {
      console.error(`Clone Failed for VM ${vmId}:`, e.message);
      return { ok: false, error: e.message };
    }
  }

  async function getRestInventory() {
    try {
      let plainPass = VCENTER_PASSWORD;
      try {
        if (/^[A-Za-z0-9+/=]+$/.test(VCENTER_PASSWORD) && VCENTER_PASSWORD.length % 4 === 0) {
           const decoded = Buffer.from(VCENTER_PASSWORD, 'base64').toString('utf-8');
           if (decoded) plainPass = decoded;
        }
      } catch (e) {}

      const auth = "Basic " + Buffer.from(`${VCENTER_USER}:${plainPass}`).toString('base64');
      const sessRes = await restClient.post("/com/vmware/cis/session", null, { headers: { Authorization: auth } });
      const sessionId = sessRes.data.value;
      const headers = { "vmware-api-session-id": sessionId };

      const [osSpecs, dcs, hosts, datastores, folders] = await Promise.all([
        restClient.get("/vcenter/guest/customization-specs", { headers }).catch(e=>({data:{value:[]}})),
        restClient.get("/vcenter/datacenter", { headers }).catch(e=>({data:{value:[]}})),
        restClient.get("/vcenter/host", { headers }).catch(e=>({data:{value:[]}})),
        restClient.get("/vcenter/datastore", { headers }).catch(e=>({data:{value:[]}})),
        restClient.get("/vcenter/folder?filter.type=VIRTUAL_MACHINE", { headers }).catch(e=>({data:{value:[]}}))
      ]);

      await restClient.delete("/com/vmware/cis/session", { headers }).catch(()=>{});

      return {
        osSpecs: osSpecs.data.value.map(x => ({ name: x.name, description: x.description })),
        datacenters: dcs.data.value.map(x => ({ name: x.name, id: x.datacenter })),
        hosts: hosts.data.value.map(x => ({ name: x.name, id: x.host, state: x.connection_state })),
        datastores: datastores.data.value.map(x => ({ name: x.name, id: x.datastore, type: x.type, free: x.free_space })),
        folders: folders.data.value.map(x => ({ name: x.name, id: x.folder }))
      };
    } catch (e) {
      throw new Error("Failed to fetch vCenter Inventory: " + e.message);
    }
  }

  // --- TASKS ---
  async function getTasksStatus(taskIds) {
    if (!taskIds || !taskIds.length) return {};
    try {
      const { propertyCollector } = await connectAndLogin();
      const objSpecs = taskIds.map(id => `<urn:objectSet><urn:obj type="Task">${id}</urn:obj><urn:skip>false</urn:skip></urn:objectSet>`).join("");
      const body = `<urn:RetrievePropertiesEx><urn:_this type="PropertyCollector">${propertyCollector}</urn:_this><urn:specSet><urn:propSet><urn:type>Task</urn:type><urn:pathSet>info.state</urn:pathSet><urn:pathSet>info.error</urn:pathSet></urn:propSet>${objSpecs}</urn:specSet><urn:options><urn:maxObjects>${taskIds.length + 10}</urn:maxObjects></urn:options></urn:RetrievePropertiesEx>`;
      const res = await postSoap(body);
      if (res.error) throw new Error(res.error);
      return parseTaskStatusResponse(res.data);
    } catch (e) { throw e; }
  }

  // FIXED PARSER: Handles namespace variations for Task Info
  const parseTaskStatusResponse = (xml) => {
    const statuses = {};
    if (!xml) return statuses;
    
    // Split by object return sets (each task response)
    // Looking for <objects> or <returnval>
    const chunks = xml.split(/<(?:\w+:)?obj type="Task">/i);
    
    for (let i = 1; i < chunks.length; i++) {
       const chunk = chunks[i];
       const idMatch = /^([^<]+)<\//.exec(chunk); 
       if (!idMatch) continue;
       const taskId = idMatch[1];
       
       let state = "unknown";
       let error = null;

       // Regex to find info.state value
       // matches: <name>info.state</name><val ...>success</val>
       const sm = chunk.match(/<(?:\w+:)?name>info\.state<\/(?:\w+:)?name>[\s\S]*?<(?:\w+:)?val[^>]*>([^<]+)<\//i);
       if (sm) state = sm[1];

       // Regex to find info.error localized message
       const em = chunk.match(/<(?:\w+:)?name>info\.error<\/(?:\w+:)?name>[\s\S]*?<(?:\w+:)?localizedMessage>([^<]+)<\//i);
       if (em) error = em[1];

       statuses[taskId] = { state, error };
    }
    return statuses;
  };

  async function resolveTargets(targetList) {
    if (!targetList || !targetList.length) return [];
    try {
      const { searchIndex } = await connectAndLogin();
      const resolved = [];
      for (const t of targetList) {
        let foundId = null;
        if (t.ips && Array.isArray(t.ips)) {
          for (const rawIp of t.ips) {
            const ip = String(rawIp).trim();
            if (!ip) continue;
            const soapBody = `<urn:FindByIp><urn:_this type="SearchIndex">${searchIndex}</urn:_this><urn:ip>${ip}</urn:ip><urn:vmSearch>true</urn:vmSearch></urn:FindByIp>`;
            const r = await postSoap(soapBody);
            if (r.error) continue;
            const vmId = extractVal(r.data, "returnval");
            if (vmId) { foundId = vmId; break; }
          }
        }
        if (foundId) resolved.push({ ...t, id: foundId });
      }
      return resolved;
    } catch (e) { throw e; }
  }

  async function createSnapshot(vmId, name, description, memory, quiesce) {
    try {
      await connectAndLogin(); 
      const res = await postSoap(`<urn:CreateSnapshot_Task><urn:_this type="VirtualMachine">${vmId}</urn:_this><urn:name>${name}</urn:name><urn:description>${description}</urn:description><urn:memory>${memory ? "true" : "false"}</urn:memory><urn:quiesce>${quiesce ? "true" : "false"}</urn:quiesce></urn:CreateSnapshot_Task>`);
      if (res.error) throw new Error(res.error);
      const taskId = extractVal(res.data, "returnval");
      return { ok: true, vmId, taskId };
    } catch (e) { return { ok: false, vmId, error: e.message }; }
  }

  return { resolveTargets, createSnapshot, getTasksStatus, getRestInventory, cloneVm };
};

module.exports = { vcenterClient };
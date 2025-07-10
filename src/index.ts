interface Env {
  DNS_KV: KVNamespace;
  MONITOR_DOMAINS: string; // Comma-separated list of domains
  DISCORD_WEBHOOK_URL: string; // Changed from Telegram variables
  DISCORD_ROLE_ID?: string; // Made this optional
  WORKER_VERSION_ID?: string; // Optional version ID from deployment
  DISCORD_BOT_TOKEN?: string; // Discord bot token for slash commands
  DISCORD_PUBLIC_KEY?: string; // Discord public key for verifying interactions
  DISCORD_APPLICATION_ID?: string; // Discord application ID for command registration
}

interface DNSResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Answer?: Array<{
    name: string;
    type: number;
    TTL: number;
    data: string;
  }>;
  Question?: Array<{
    name: string;
    type: number;
  }>;
  Comment?: string[];
}

// Discord embed interface definitions
interface DiscordEmbed {
  title: string;
  description?: string;
  color: number; // Decimal color value
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  timestamp?: string;
  footer?: {
    text: string;
    icon_url?: string;
  };
}

interface DiscordWebhookPayload {
  content?: string;
  embeds: DiscordEmbed[];
  username?: string;
  avatar_url?: string;
}

// Discord interaction types
interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  data?: {
    id: string;
    name: string;
    type: number;
    options?: Array<{
      name: string;
      type: number;
      value: string;
    }>;
  };
  guild_id?: string;
  channel_id?: string;
  member?: {
    user: {
      id: string;
      username: string;
    };
    roles: string[];
  };
  user?: {
    id: string;
    username: string;
  };
  token: string;
  version: number;
}

interface DiscordInteractionResponse {
  type: number;
  data?: {
    content?: string;
    embeds?: DiscordEmbed[];
    flags?: number;
  };
}

// Discord command definitions
const DISCORD_COMMANDS = [
  {
    name: "help",
    description: "Show available DNS monitoring commands"
  },
  {
    name: "add",
    description: "Add a domain to DNS monitoring",
    options: [
      {
        name: "domain",
        description: "Domain name to monitor (e.g., example.com)",
        type: 3, // STRING
        required: true
      }
    ]
  },
  {
    name: "remove", 
    description: "Remove a domain from DNS monitoring",
    options: [
      {
        name: "domain",
        description: "Domain name to stop monitoring",
        type: 3, // STRING
        required: true
      }
    ]
  },
  {
    name: "list",
    description: "List all monitored domains"
  },
  {
    name: "status",
    description: "Check current status of a specific domain",
    options: [
      {
        name: "domain", 
        description: "Domain name to check",
        type: 3, // STRING
        required: true
      }
    ]
  }
];

async function sendDiscordMessage(env: Env, embed: DiscordEmbed, content?: string): Promise<void> {
  const payload: DiscordWebhookPayload = {
    embeds: [embed],
    username: "DNS Monitor Bot",
    content: content
  };

  console.log(`Sending Discord message with payload: ${JSON.stringify(payload)}`);
  console.log(`Using webhook URL: ${env.DISCORD_WEBHOOK_URL.substring(0, 20)}...`); // Only log partial URL for security

  try {
    const response = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(`Discord API response status: ${response.status}`);
    
    const responseText = await response.text();
    console.log(`Discord API response body: ${responseText}`);

    if (!response.ok) {
      throw new Error(`Failed to send Discord message: ${response.status} ${response.statusText} - ${responseText}`);
    }
    
    console.log("✅ Discord message sent successfully");
  } catch (error) {
    console.error(`❌ Error sending Discord message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Error details: ${JSON.stringify(error)}`);
    throw error; // Re-throw to allow caller to handle
  }
}

// Helper to create colored embeds based on notification type
function createEmbed(type: 'error' | 'warning' | 'change' | 'update', title: string): DiscordEmbed {
  // Discord colors (decimal values)
  const colors = {
    error: 16711680,    // Red
    warning: 16763904,  // Yellow/Amber
    change: 16746496,   // Orange
    update: 5793266,    // Light blue
  };
  
  return {
    title: title,
    color: colors[type],
    timestamp: new Date().toISOString(),
    footer: {
      text: "DNS Monitor Bot"
    }
  };
}

async function queryDNS(domain: string): Promise<DNSResponse> {
  const server = "https://1.1.1.1/dns-query";
  const url = new URL(server);
  url.searchParams.append("name", domain);
  url.searchParams.append("type", "SOA"); // First query SOA record

  console.log(`Querying DNS server for SOA: ${url.toString()}`);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-json",
    },
  });

  console.log(`Response status:`, response.status);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  console.log("Response headers:", JSON.stringify(responseHeaders, null, 2));

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DNS query failed: ${response.status} - ${errorText}`);
  }

  const soaData: DNSResponse = await response.json();
  console.log("SOA Response data:", JSON.stringify(soaData, null, 2));

  // Now query A records
  url.searchParams.set("type", "A");
  console.log(`Querying DNS server for A records: ${url.toString()}`);

  const aResponse = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/dns-json",
    },
  });

  if (!aResponse.ok) {
    const errorText = await aResponse.text();
    throw new Error(`DNS query failed: ${aResponse.status} - ${errorText}`);
  }

  const aData: DNSResponse = await aResponse.json();
  console.log("A Record Response data:", JSON.stringify(aData, null, 2));

  // Combine both responses
  return {
    ...aData,
    Answer: [...(aData.Answer || []), ...(soaData.Answer || [])],
  };
}

async function checkDomain(domain: string, env: Env): Promise<void> {
  try {
    const dnsData = await queryDNS(domain);

    // Check for "No Reachable Authority" case
    const noAuthority = dnsData.Comment?.some((comment) =>
      comment.includes("No Reachable Authority")
    );

    if (noAuthority) {
      // Get the previous state from KV
      const previousState = await env.DNS_KV.get(`dns:${domain}:state`);

      if (previousState !== "no_authority") {
        // State has changed to no authority
        await env.DNS_KV.put(`dns:${domain}:state`, "no_authority");

        const embed = createEmbed('warning', 'DNS Authority Unreachable');
        embed.description = `Domain: \`${domain}\` is unreachable`;
        embed.fields = [
          {
            name: "Status",
            value: "No Reachable Authority",
            inline: true
          },
          {
            name: "DNS Status",
            value: `${dnsData.Status}`,
            inline: true
          },
          {
            name: "Comments",
            value: dnsData.Comment?.join(", ") || "None",
            inline: false
          }
        ];

        await sendDiscordMessage(env, embed);
        console.log(`DNS authority unreachable for ${domain}`);
      }
      return;
    }

    // Get all A records
    const aRecords =
      dnsData.Answer?.filter((answer) => answer.type === 1) || [];

    // Get SOA record
    const soaRecord = dnsData.Answer?.find((answer) => answer.type === 6);
    const soaData = soaRecord?.data.split(" ") || [];
    const serial = soaData[2] || "unknown";

    // Get the previous state and IPs from KV
    const previousState = await env.DNS_KV.get(`dns:${domain}:state`);
    const previousIPs = await env.DNS_KV.get(`dns:${domain}:ips`);
    const previousSerial = await env.DNS_KV.get(`dns:${domain}:serial`);
    const previousIPsArray = previousIPs ? previousIPs.split(",") : [];
    const currentIPs = aRecords.map((record) => record.data);

    // Sort arrays for consistent comparison
    previousIPsArray.sort();
    currentIPs.sort();

    // If the IPs have changed
    if (JSON.stringify(previousIPsArray) !== JSON.stringify(currentIPs)) {
      await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
      await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);

      const embed = createEmbed('change', 'DNS Change Detected');
      embed.description = `IP addresses for \`${domain}\` have changed`;
      embed.fields = [
        {
          name: "Previous IPs",
          value: previousIPs || "none",
          inline: false
        },
        {
          name: "New IPs",
          value: currentIPs.join(", "),
          inline: false
        },
        {
          name: "TTL",
          value: `${aRecords[0]?.TTL || "N/A"}`,
          inline: true
        },
        {
          name: "DNS Status",
          value: `${dnsData.Status}`,
          inline: true
        },
        {
          name: "Record Type",
          value: "A",
          inline: true
        },
        {
          name: "SOA Serial",
          value: serial,
          inline: true
        },
        {
          name: "Primary NS",
          value: soaData[0] || "unknown",
          inline: true
        },
        {
          name: "Admin Email",
          value: soaData[1] || "unknown",
          inline: true
        }
      ];

      // Only add role mention if DISCORD_ROLE_ID is set
      const mentionContent = env.DISCORD_ROLE_ID ? `<@&${env.DISCORD_ROLE_ID}>` : undefined;
      await sendDiscordMessage(env, embed, mentionContent);
      
      console.log(`DNS change detected for ${domain}:`);
      console.log(`Previous IPs: ${previousIPs || "none"}`);
      console.log(`New IPs: ${currentIPs.join(", ")}`);
      console.log(`SOA Serial: ${serial}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
    } else if (serial !== previousSerial) {
      // Only notify on SOA changes if IPs haven't changed
      // This catches cases where other record types changed
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);

      const embed = createEmbed('update', 'DNS Zone Updated');
      embed.description = `SOA record for \`${domain}\` has been updated`;
      embed.fields = [
        {
          name: "Previous Serial",
          value: previousSerial || "unknown",
          inline: true
        },
        {
          name: "New Serial",
          value: serial,
          inline: true
        },
        {
          name: "Primary NS",
          value: soaData[0] || "unknown",
          inline: true
        },
        {
          name: "Admin Email",
          value: soaData[1] || "unknown",
          inline: true
        },
        {
          name: "Refresh/Retry/Expire/Min TTL",
          value: `${soaData[3] || "?"} / ${soaData[4] || "?"} / ${soaData[5] || "?"} / ${soaData[6] || "?"}`,
          inline: false
        }
      ];

      await sendDiscordMessage(env, embed);
      console.log(`SOA record updated for ${domain}:`);
      console.log(`Previous Serial: ${previousSerial || "unknown"}`);
      console.log(`New Serial: ${serial}`);
    } else {
      console.log(
        `No change detected for ${domain} (IPs: ${currentIPs.join(", ")})`
      );
    }
  } catch (error: unknown) {
    const embed = createEmbed('error', 'Error Monitoring DNS');
    embed.description = `Failed to check domain \`${domain}\``;
    embed.fields = [
      {
        name: "Error",
        value: error instanceof Error ? error.message : String(error),
        inline: false
      },
      {
        name: "Worker",
        value: "dns-bot",
        inline: true
      },
      {
        name: "Time",
        value: new Date().toISOString(),
        inline: true
      }
    ];

    await sendDiscordMessage(env, embed);
    console.error(`Error monitoring DNS for ${domain}:`, error);
  }
}

// Utility functions for Discord bot
function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

async function verifyDiscordRequest(request: Request, env: Env, body: string): Promise<boolean> {
  if (!env.DISCORD_PUBLIC_KEY) {
    console.log("Discord public key not set");
    return false;
  }

  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (!signature || !timestamp) {
    console.log("Missing signature or timestamp");
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToArrayBuffer(env.DISCORD_PUBLIC_KEY),
      { name: "Ed25519", namedCurve: "Ed25519" },
      false,
      ["verify"]
    );

    const message = new TextEncoder().encode(timestamp + body);
    const signatureBuffer = hexToArrayBuffer(signature);

    return await crypto.subtle.verify("Ed25519", key, signatureBuffer, message);
  } catch (error) {
    console.error("Error verifying Discord request:", error);
    return false;
  }
}

async function registerCommands(env: Env): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) {
    console.log("Discord bot token not set, skipping command registration");
    return;
  }

  const url = `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`;
  
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(DISCORD_COMMANDS)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Failed to register commands:", error);
    } else {
      console.log("Discord commands registered successfully");
    }
  } catch (error) {
    console.error("Error registering Discord commands:", error);
  }
}

async function updateDiscordPresence(env: Env, activityName: string): Promise<boolean> {
  try {
    // Get gateway URL
    const gatewayResponse = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: {
        "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
      },
    });
    
    if (!gatewayResponse.ok) {
      throw new Error("Failed to get gateway URL");
    }
    
    const gatewayData: { url: string; session_start_limit: any } = await gatewayResponse.json();
    const wsUrl = `${gatewayData.url}?v=10&encoding=json`;
    
    // Create WebSocket connection for presence update
    const ws = new WebSocket(wsUrl);
    
    return new Promise((resolve) => {
      let heartbeatInterval: any;
      let identified = false;
      
      const cleanup = () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        } catch (e) {
          // Ignore close errors
        }
      };
      
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, 10000); // 10 second timeout
      
      ws.onopen = () => {
        console.log("WebSocket connected for presence update");
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          
          if (data.op === 10) { // Hello
            const heartbeatMs = data.d.heartbeat_interval;
            console.log(`Received hello, heartbeat interval: ${heartbeatMs}ms`);
            
            // Start heartbeat
            heartbeatInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: null }));
              }
            }, heartbeatMs);
            
            // Send identify
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: env.DISCORD_BOT_TOKEN,
                intents: 0, // No intents needed for presence
                properties: {
                  $os: "linux",
                  $browser: "cloudflare-worker",
                  $device: "cloudflare-worker"
                },
                presence: {
                  activities: [{
                    name: activityName,
                    type: 3 // Watching
                  }],
                  status: "online",
                  since: null,
                  afk: false
                }
              }
            }));
          } else if (data.op === 0 && data.t === "READY") {
            console.log("Bot identified successfully, presence should be updated");
            identified = true;
            clearTimeout(timeout);
            
            // Wait a moment then close connection
            setTimeout(() => {
              cleanup();
              resolve(true);
            }, 2000);
          } else if (data.op === 11) { // Heartbeat ACK
            console.log("Heartbeat acknowledged");
          }
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
        }
      };
      
      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        clearTimeout(timeout);
        cleanup();
        resolve(false);
      };
      
      ws.onclose = () => {
        console.log("WebSocket closed");
        clearTimeout(timeout);
        cleanup();
        if (!identified) {
          resolve(false);
        }
      };
    });
  } catch (error) {
    console.error("Error creating WebSocket connection:", error);
    return false;
  }
}

async function updateBotStatus(env: Env, totalDomains: number, lastCheckTime: string): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) {
    console.log("Discord bot token not set, skipping status update");
    return;
  }

  try {
    // Format the last check time to be more readable
    const checkTime = new Date(lastCheckTime);
    const timeString = checkTime.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit'
    });
    
    // Create activity status with last check time
    const activityName = `${totalDomains} domains | Last: ${timeString} UTC`;
    
    // Store the status information in KV for display purposes
    const statusInfo = {
      online: true,
      lastCheck: lastCheckTime,
      domainsMonitored: totalDomains,
      activity: activityName,
      updatedAt: new Date().toISOString()
    };
    
    await env.DNS_KV.put("bot:status", JSON.stringify(statusInfo));
    
    // Try to update Discord presence via WebSocket
    console.log(`Attempting to update Discord presence: ${activityName}`);
    
    try {
      const presenceUpdated = await updateDiscordPresence(env, activityName);
      if (presenceUpdated) {
        console.log(`✅ Discord presence updated successfully: ${activityName}`);
      } else {
        console.log(`⚠️ Discord presence update failed, status stored in KV only`);
      }
    } catch (presenceError) {
      console.error("Error updating Discord presence:", presenceError);
      console.log(`⚠️ Presence update failed, but status stored in KV: ${activityName}`);
    }
    
  } catch (error) {
    console.error("Error updating bot status:", error);
    
    // Fallback: Just store in KV
    const statusInfo = {
      online: true,
      lastCheck: lastCheckTime,
      domainsMonitored: totalDomains,
      activity: `Watching ${totalDomains} domains`,
      updatedAt: new Date().toISOString()
    };
    
    await env.DNS_KV.put("bot:status", JSON.stringify(statusInfo));
  }
}

async function getBotStatus(env: Env): Promise<any> {
  try {
    const statusData = await env.DNS_KV.get("bot:status");
    if (statusData) {
      return JSON.parse(statusData);
    }
    return {
      online: false,
      lastCheck: "Never",
      domainsMonitored: 0,
      activity: "Offline",
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error getting bot status:", error);
    return {
      online: false,
      lastCheck: "Error",
      domainsMonitored: 0,
      activity: "Error",
      updatedAt: new Date().toISOString()
    };
  }
}

async function getDynamicDomains(env: Env): Promise<string[]> {
  try {
    const domainsData = await env.DNS_KV.get("dynamic:domains");
    if (domainsData) {
      return JSON.parse(domainsData);
    }
    return [];
  } catch (error) {
    console.error("Error getting dynamic domains:", error);
    return [];
  }
}

async function saveDynamicDomains(env: Env, domains: string[]): Promise<void> {
  try {
    await env.DNS_KV.put("dynamic:domains", JSON.stringify(domains));
  } catch (error) {
    console.error("Error saving dynamic domains:", error);
    throw error;
  }
}

function isValidDomain(domain: string): boolean {
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return domainRegex.test(domain) && domain.length <= 253;
}

async function handleAddDomain(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  const domain = interaction.data?.options?.[0]?.value?.toLowerCase();
  
  if (!domain) {
    return {
      type: 4,
      data: {
        content: "❌ Please provide a domain name.",
        flags: 64 // EPHEMERAL
      }
    };
  }

  if (!isValidDomain(domain)) {
    return {
      type: 4,
      data: {
        content: `❌ Invalid domain format: \`${domain}\``,
        flags: 64
      }
    };
  }

  try {
    const domains = await getDynamicDomains(env);
    
    if (domains.includes(domain)) {
      return {
        type: 4,
        data: {
          content: `⚠️ Domain \`${domain}\` is already being monitored.`,
          flags: 64
        }
      };
    }

         domains.push(domain);
     await saveDynamicDomains(env, domains);

     // Update bot status with new domain count
     const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
     const totalDomains = staticDomains.length + domains.length;
     await updateBotStatus(env, totalDomains, new Date().toISOString());

     const embed = createEmbed('update', 'Domain Added');
     embed.description = `Successfully added \`${domain}\` to DNS monitoring`;
     embed.fields = [
       {
         name: "Domain",
         value: domain,
         inline: true
       },
       {
         name: "Total Domains", 
         value: totalDomains.toString(),
         inline: true
       },
       {
         name: "Added By",
         value: interaction.member?.user?.username || interaction.user?.username || "Unknown",
         inline: true
       }
     ];

    return {
      type: 4,
      data: {
        embeds: [embed]
      }
    };
  } catch (error) {
    console.error("Error adding domain:", error);
    return {
      type: 4,
      data: {
        content: `❌ Failed to add domain: ${error instanceof Error ? error.message : String(error)}`,
        flags: 64
      }
    };
  }
}

async function handleRemoveDomain(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  const domain = interaction.data?.options?.[0]?.value?.toLowerCase();
  
  if (!domain) {
    return {
      type: 4,
      data: {
        content: "❌ Please provide a domain name.",
        flags: 64
      }
    };
  }

  try {
    const domains = await getDynamicDomains(env);
    const domainIndex = domains.indexOf(domain);
    
    if (domainIndex === -1) {
      return {
        type: 4,
        data: {
          content: `⚠️ Domain \`${domain}\` is not currently being monitored.`,
          flags: 64
        }
      };
    }

         domains.splice(domainIndex, 1);
     await saveDynamicDomains(env, domains);

     // Clean up stored DNS data for this domain
     await env.DNS_KV.delete(`dns:${domain}:ips`);
     await env.DNS_KV.delete(`dns:${domain}:serial`);
     await env.DNS_KV.delete(`dns:${domain}:state`);

     // Update bot status with new domain count
     const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
     const totalDomains = staticDomains.length + domains.length;
     await updateBotStatus(env, totalDomains, new Date().toISOString());

     const embed = createEmbed('update', 'Domain Removed');
     embed.description = `Successfully removed \`${domain}\` from DNS monitoring`;
     embed.fields = [
       {
         name: "Domain",
         value: domain,
         inline: true
       },
       {
         name: "Remaining Domains",
         value: totalDomains.toString(),
         inline: true
       },
       {
         name: "Removed By",
         value: interaction.member?.user?.username || interaction.user?.username || "Unknown",
         inline: true
       }
     ];

    return {
      type: 4,
      data: {
        embeds: [embed]
      }
    };
  } catch (error) {
    console.error("Error removing domain:", error);
    return {
      type: 4,
      data: {
        content: `❌ Failed to remove domain: ${error instanceof Error ? error.message : String(error)}`,
        flags: 64
      }
    };
  }
}

async function handleListDomains(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  try {
    const dynamicDomains = await getDynamicDomains(env);
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
    
    const embed = createEmbed('update', 'Monitored Domains');
    
    if (dynamicDomains.length === 0 && staticDomains.length === 0) {
      embed.description = "No domains are currently being monitored.";
    } else {
      embed.description = "Currently monitored domains:";
      
      const fields = [];
      
      if (staticDomains.length > 0) {
        fields.push({
          name: "📋 Static Domains (from config)",
          value: staticDomains.map(d => `\`${d}\``).join(", "),
          inline: false
        });
      }
      
      if (dynamicDomains.length > 0) {
        fields.push({
          name: "🔧 Dynamic Domains (bot managed)",
          value: dynamicDomains.map(d => `\`${d}\``).join(", "),
          inline: false
        });
      }
      
      fields.push({
        name: "📊 Total Count",
        value: `${staticDomains.length + dynamicDomains.length} domains`,
        inline: true
      });
      
      embed.fields = fields;
    }

    return {
      type: 4,
      data: {
        embeds: [embed]
      }
    };
  } catch (error) {
    console.error("Error listing domains:", error);
    return {
      type: 4,
      data: {
        content: `❌ Failed to list domains: ${error instanceof Error ? error.message : String(error)}`,
        flags: 64
      }
    };
  }
}

async function handleDomainStatus(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  const domain = interaction.data?.options?.[0]?.value?.toLowerCase();
  
  if (!domain) {
    return {
      type: 4,
      data: {
        content: "❌ Please provide a domain name.",
        flags: 64
      }
    };
  }

  try {
    // Check if domain is being monitored
    const dynamicDomains = await getDynamicDomains(env);
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
    const allDomains = [...staticDomains, ...dynamicDomains];
    
         if (!allDomains.includes(domain)) {
       return {
         type: 4,
         data: {
           content: `⚠️ Domain \`${domain}\` is not currently being monitored. Use \`/add\` to start monitoring it.`,
           flags: 64
         }
       };
     }

    // Get current DNS data
    const dnsData = await queryDNS(domain);
    const storedIPs = await env.DNS_KV.get(`dns:${domain}:ips`);
    const storedSerial = await env.DNS_KV.get(`dns:${domain}:serial`);
    const storedState = await env.DNS_KV.get(`dns:${domain}:state`);

    const currentIPs = dnsData.Answer?.filter(answer => answer.type === 1)
      .map(answer => answer.data) || [];
    
    const soaRecord = dnsData.Answer?.find(answer => answer.type === 6);
    const soaData = soaRecord?.data.split(" ") || [];
    const currentSerial = soaData[2];

    const embed = createEmbed('update', `Domain Status: ${domain}`);
    embed.fields = [
      {
        name: "🌐 Current IP Addresses",
        value: currentIPs.length > 0 ? currentIPs.map(ip => `\`${ip}\``).join(", ") : "None found",
        inline: false
      },
      {
        name: "📊 DNS Status",
        value: dnsData.Status.toString(),
        inline: true
      },
      {
        name: "🔢 SOA Serial",
        value: currentSerial || "Unknown",
        inline: true
      },
      {
        name: "📋 Stored State",
        value: storedState || "Not set",
        inline: true
      }
    ];

    if (soaData.length >= 7) {
      embed.fields.push({
        name: "🏷️ Primary Nameserver",
        value: soaData[0] || "Unknown",
        inline: true
      });
      embed.fields.push({
        name: "✉️ Admin Email",
        value: soaData[1] || "Unknown", 
        inline: true
      });
    }

    if (storedIPs) {
      embed.fields.push({
        name: "💾 Last Known IPs",
        value: `\`${storedIPs}\``,
        inline: false
      });
    }

    return {
      type: 4,
      data: {
        embeds: [embed]
      }
    };
  } catch (error) {
    console.error("Error checking domain status:", error);
    return {
      type: 4,
      data: {
        content: `❌ Failed to check domain status: ${error instanceof Error ? error.message : String(error)}`,
        flags: 64
      }
    };
  }
}

async function handleHelp(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  const botStatus = await getBotStatus(env);
  const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
  const dynamicDomains = await getDynamicDomains(env);
  const totalDomains = staticDomains.length + dynamicDomains.length;
  
  const embed = createEmbed('update', 'DNS Monitor Bot Commands');
  embed.description = "Available commands for managing DNS monitoring:";
  embed.fields = [
    {
      name: "🤖 Bot Status",
      value: `**Activity:** ${botStatus.activity}\n**Last Check:** ${botStatus.lastCheck}\n**Domains Monitored:** ${totalDomains}`,
      inline: false
    },
    {
      name: "📋 `/list`",
      value: "Show all monitored domains (static + dynamic)",
      inline: false
    },
    {
      name: "➕ `/add <domain>`",
      value: "Add a domain to monitoring\nExample: `/add example.com`",
      inline: false
    },
    {
      name: "➖ `/remove <domain>`",
      value: "Remove a domain from monitoring\nExample: `/remove example.com`",
      inline: false
    },
    {
      name: "📊 `/status <domain>`",
      value: "Check current DNS status of a domain\nExample: `/status example.com`",
      inline: false
    },
    {
      name: "ℹ️ About",
      value: "This bot monitors DNS changes and sends notifications when IP addresses or DNS records change.",
      inline: false
    }
  ];

  return {
    type: 4,
    data: {
      embeds: [embed]
    }
  };
}

async function handleDiscordInteraction(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  // Handle ping
  if (interaction.type === 1) {
    return { type: 1 };
  }

  // Handle application commands
  if (interaction.type === 2) {
    const commandName = interaction.data?.name;
    
    switch (commandName) {
      case "help":
        return await handleHelp(interaction, env);
      case "add":
        return await handleAddDomain(interaction, env);
      case "remove":
        return await handleRemoveDomain(interaction, env);
      case "list":
        return await handleListDomains(interaction, env);
      case "status":
        return await handleDomainStatus(interaction, env);
      default:
        return {
          type: 4,
          data: {
            content: "❌ Unknown command. Use `/help` to see available commands.",
            flags: 64
          }
        };
    }
  }

  return {
    type: 4,
    data: {
      content: "❌ Unsupported interaction type",
      flags: 64
    }
  };
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (!env.DISCORD_WEBHOOK_URL) {
      console.error("Discord webhook URL is missing. Please set DISCORD_WEBHOOK_URL");
      return;
    }

    // Get both static and dynamic domains
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map((domain) => domain.trim()) : [];
    const dynamicDomains = await getDynamicDomains(env);
    const allDomains = [...staticDomains, ...dynamicDomains];
    
    if (allDomains.length === 0) {
      console.log("No domains to monitor. Use Discord commands to add domains or set MONITOR_DOMAINS env var.");
      return;
    }

    console.log("===== DNS MONITOR WORKER EXECUTION =====");
    console.log(`Worker execution time: ${new Date().toISOString()}`);
    console.log(`Scheduled time: ${new Date(event.scheduledTime).toISOString()}`);
    console.log(`Static domains: ${staticDomains.join(", ") || "none"}`);
    console.log(`Dynamic domains: ${dynamicDomains.join(", ") || "none"}`);
    console.log(`Total domains to check: ${allDomains.length}`);
    
    // Store version ID in KV if it exists and notify about new deployments
    if (env.WORKER_VERSION_ID) {
      const existingVersion = await env.DNS_KV.get("system:version_id");
      if (existingVersion !== env.WORKER_VERSION_ID) {
        console.log(`New deployment detected! Version ID: ${env.WORKER_VERSION_ID}`);
        
        // Send deployment notification via Discord
        const deploymentEmbed = createEmbed('update', 'New Worker Deployment');
        deploymentEmbed.description = "DNS Monitor Worker has been updated with a new deployment";
        deploymentEmbed.fields = [
          {
            name: "Previous Version",
            value: existingVersion || "Not available",
            inline: true
          },
          {
            name: "New Version",
            value: env.WORKER_VERSION_ID,
            inline: true
          },
          {
            name: "Static Domains",
            value: staticDomains.map(d => `\`${d}\``).join(", ") || "None",
            inline: false
          },
          {
            name: "Dynamic Domains",
            value: dynamicDomains.map(d => `\`${d}\``).join(", ") || "None",
            inline: false
          },
          {
            name: "Total Monitored",
            value: `${allDomains.length} domains`,
            inline: true
          },
          {
            name: "Deployment Time",
            value: new Date().toISOString(),
            inline: true
          }
        ];
        
        try {
          await sendDiscordMessage(env, deploymentEmbed);
          console.log("✅ Deployment notification sent to Discord");
        } catch (error) {
          console.error("❌ Failed to send deployment notification:", error);
        }
        
                 // Register Discord commands on new deployment
         if (env.DISCORD_BOT_TOKEN && env.DISCORD_APPLICATION_ID) {
           try {
             await registerCommands(env);
             console.log("✅ Discord commands registered");
             
             // Set initial bot status
             await updateBotStatus(env, allDomains.length, new Date().toISOString());
           } catch (error) {
             console.error("❌ Failed to register Discord commands:", error);
           }
         }
        
        // After notification, store the new version ID
        console.log(`Storing worker version ID: ${env.WORKER_VERSION_ID}`);
        await env.DNS_KV.put("system:version_id", env.WORKER_VERSION_ID);
      }
    }
    
    console.log("Starting domain checks...");
    const checkStartTime = new Date().toISOString();
    
    // Check each domain
    for (const domain of allDomains) {
      await checkDomain(domain, env);
    }
    
    // Update bot status after checking domains
    try {
      await updateBotStatus(env, allDomains.length, checkStartTime);
    } catch (error) {
      console.error("Failed to update bot status:", error);
    }
    
    console.log("===== WORKER EXECUTION COMPLETE =====");
  },

  // Handle Discord interactions and HTTP requests
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle Discord interactions
    if (request.method === "POST" && url.pathname === "/") {
      console.log("Received Discord interaction");
      
             // Get the request body for verification
       const requestBody = await request.text();
       
       // Verify the request is from Discord
       const isValid = await verifyDiscordRequest(request, env, requestBody);
      if (!isValid) {
        console.log("Invalid Discord request signature");
        return new Response("Unauthorized", { status: 401 });
      }
      
             try {
         const interaction: DiscordInteraction = JSON.parse(requestBody);
         console.log(`Handling interaction type: ${interaction.type}, command: ${interaction.data?.name || 'none'}`);
         
         const response = await handleDiscordInteraction(interaction, env);
        
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Error handling Discord interaction:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }
    
         // Handle command registration endpoint (for manual registration)
     if (request.method === "POST" && url.pathname === "/register-commands") {
       if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID) {
         return new Response("Discord bot configuration missing", { status: 400 });
       }
       
       try {
         await registerCommands(env);
         
         // Update bot status after registering commands
         const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
         const dynamicDomains = await getDynamicDomains(env);
         const totalDomains = staticDomains.length + dynamicDomains.length;
         await updateBotStatus(env, totalDomains, new Date().toISOString());
         
         return new Response("Commands registered successfully", { 
           headers: { "Content-Type": "text/plain" } 
         });
       } catch (error) {
         console.error("Error registering commands:", error);
         return new Response(`Failed to register commands: ${error}`, { status: 500 });
       }
     }
    
         // Handle status endpoint
     if (request.method === "GET" && url.pathname === "/status") {
       const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
       const dynamicDomains = await getDynamicDomains(env);
       const botStatus = await getBotStatus(env);
       
       const status = {
         worker: {
           status: "running",
           version: env.WORKER_VERSION_ID || "unknown",
           discordBotConfigured: !!(env.DISCORD_BOT_TOKEN && env.DISCORD_APPLICATION_ID && env.DISCORD_PUBLIC_KEY),
           webhookConfigured: !!env.DISCORD_WEBHOOK_URL,
           lastUpdated: new Date().toISOString()
         },
         bot: {
           online: botStatus.online,
           activity: botStatus.activity,
           lastCheck: botStatus.lastCheck,
           updatedAt: botStatus.updatedAt
         },
         domains: {
           static: staticDomains,
           dynamic: dynamicDomains,
           total: staticDomains.length + dynamicDomains.length
         }
       };
       
       return new Response(JSON.stringify(status, null, 2), {
         headers: { "Content-Type": "application/json" },
       });
     }
    
         // Default response for other requests
     return new Response(
       "DNS Monitor Worker with Discord Bot\n\n" +
       "Endpoints:\n" +
       "POST / - Discord interactions\n" +
       "POST /register-commands - Manual command registration\n" +
       "GET /status - Worker status\n\n" +
       "Discord Commands:\n" +
       "/help - Show available commands\n" +
       "/list - List monitored domains\n" +
       "/add <domain> - Add domain to monitoring\n" +
       "/remove <domain> - Remove domain from monitoring\n" +
       "/status <domain> - Check domain status\n\n" +
       "This worker monitors DNS changes and provides Discord bot commands for domain management.",
       {
         headers: { "Content-Type": "text/plain" },
       }
     );
  },
};

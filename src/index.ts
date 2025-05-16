interface Env {
  DNS_KV: KVNamespace;
  MONITOR_DOMAINS: string; // Comma-separated list of domains
  DISCORD_WEBHOOK_URL: string; // Changed from Telegram variables
  DISCORD_ROLE_TAG: string; // Added this for the role mention tag
  WORKER_VERSION_ID?: string; // Optional version ID from deployment
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

      await sendDiscordMessage(env, embed, `<@&${env.DISCORD_ROLE_TAG}>`);
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

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (!env.MONITOR_DOMAINS) {
      console.error("MONITOR_DOMAINS environment variable is not set");
      return;
    }

    if (!env.DISCORD_WEBHOOK_URL) {
      console.error("Discord webhook URL is missing. Please set DISCORD_WEBHOOK_URL");
      return;
    }

    if (!env.DISCORD_ROLE_TAG) {
      console.error("Discord role tag is missing. Please set DISCORD_ROLE_TAG");
      return;
    }

    // Split the domains string into an array and trim whitespace
    const domains = env.MONITOR_DOMAINS.split(",").map((domain) => domain.trim());
    
    console.log("===== DNS MONITOR WORKER EXECUTION =====");
    console.log(`Worker execution time: ${new Date().toISOString()}`);
    console.log(`Scheduled time: ${new Date(event.scheduledTime).toISOString()}`);
    
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
            name: "Deployment Time",
            value: new Date().toISOString(),
            inline: false
          }
        ];
        
        try {
          await sendDiscordMessage(env, deploymentEmbed);
          console.log("✅ Deployment notification sent to Discord");
        } catch (error) {
          console.error("❌ Failed to send deployment notification:", error);
        }
        
        // After notification, store the new version ID
        console.log(`Storing worker version ID: ${env.WORKER_VERSION_ID}`);
        await env.DNS_KV.put("system:version_id", env.WORKER_VERSION_ID);
      }
    }
    
    console.log("Starting domain checks...");
    // Check each domain
    for (const domain of domains) {
      await checkDomain(domain, env);
    }
    
    console.log("===== WORKER EXECUTION COMPLETE =====");
  },

  // Add fetch handler for HTTP requests
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return new Response(
      "DNS Monitor Worker is running. This worker is triggered by cron.",
      {
        headers: { "Content-Type": "text/plain" },
      }
    );
  },
};

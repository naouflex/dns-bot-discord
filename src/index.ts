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

// Enhanced Dampening Interfaces
interface ChangeContext {
  timestamp: number;
  previousIPs: string[];
  currentIPs: string[];
  ttl: number;
  changeType: 'addition' | 'removal' | 'replacement' | 'complete_change';
  geoContext?: {
    regions: string[];
    previousRegions: string[];
    crossRegion: boolean;
  };
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number; // 0-1 scale for pattern confidence
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
    name: "add-with-subdomains", 
    description: "Add domain + subdomains via Certificate Transparency logs ",
    options: [
      {
        name: "domain",
        description: "Domain name to discover and monitor subdomains for (e.g., example.com)",
        type: 3, // STRING
        required: true
      },
      {
        name: "verify-all",
        description: "Verify all discovered domains are active (slower but more accurate)",
        type: 5, // BOOLEAN
        required: false
      }
    ]
  },
  {
    name: "discover",
    description: "Thorough subdomain discovery using multiple methods with full verification",
    options: [
      {
        name: "domain",
        description: "Domain name to perform comprehensive subdomain discovery for",
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
    name: "remove-with-subdomains",
    description: "Remove domain + all subdomains from monitoring ",
    options: [
      {
        name: "domain",
        description: "Domain name to remove along with all its subdomains",
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
  },
  {
    name: "dampening",
    description: "Check or clear DNS change notification dampening for a domain",
    options: [
      {
        name: "domain",
        description: "Domain name to check dampening status",
        type: 3, // STRING
        required: true
      },
      {
        name: "clear",
        description: "Clear dampening to allow immediate notifications",
        type: 5, // BOOLEAN
        required: false
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

// Enhanced Notification Builder
class IntelligentNotificationBuilder {
  static buildEnhancedNotification(
    domain: string,
    previousIPs: string[],
    currentIPs: string[],
    context: ChangeContext,
    cdnInfo: ReturnType<typeof IntelligentCDNDetector.detectProvider>,
    lbInfo: ReturnType<typeof LoadBalancerIntelligence.analyzePattern>,
    timeInfo: ReturnType<typeof TemporalAnalyzer.analyzeTimePatterns>,
    soaData?: string[],
    coordinatedInfo?: { isCoordinated: boolean; confidence: number; analysis: string; relatedDomains: string[] }
  ): DiscordEmbed {
    const embed: DiscordEmbed = {
      title: this.getSmartTitle(context, cdnInfo, lbInfo, timeInfo, coordinatedInfo),
      description: `IP addresses for \`${domain}\` have changed`,
      color: this.getSeverityColor(context.severity),
      fields: [
        {
          name: "Previous IPs",
          value: previousIPs.join(", ") || "none",
          inline: false
        },
        {
          name: "New IPs", 
          value: currentIPs.join(", "),
          inline: false
        },
        {
          name: "📊 Change Analysis",
          value: this.buildAnalysisText(context, cdnInfo, lbInfo, timeInfo),
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: `DNS Monitor • Confidence: ${Math.round(context.confidence * 100)}%`
      }
    };

    // Add context-specific fields
    if (cdnInfo.isAnyCDN) {
      embed.fields!.push({
        name: "🌐 CDN Information",
        value: cdnInfo.provider ? 
          `Provider: ${cdnInfo.provider} (${Math.round(cdnInfo.confidence * 100)}% confidence)` :
          `Generic CDN detected (${Math.round(cdnInfo.confidence * 100)}% confidence)`,
        inline: true
      });
    }

    if (lbInfo.isLoadBalancer) {
      embed.fields!.push({
        name: "⚖️ Load Balancer Details",
        value: `Pattern: ${lbInfo.pattern}\nAnalysis: ${lbInfo.analysis}`,
        inline: false
      });
    }

    // Add coordinated change information
    if (coordinatedInfo?.isCoordinated) {
      embed.fields!.push({
        name: "🌐 Coordinated Infrastructure Change",
        value: `**Analysis:** ${coordinatedInfo.analysis}\n**Related Domains:** ${coordinatedInfo.relatedDomains.slice(0, 3).map(d => `\`${d}\``).join(', ')}${coordinatedInfo.relatedDomains.length > 3 ? ` and ${coordinatedInfo.relatedDomains.length - 3} more...` : ''}`,
        inline: false
      });
    }

    // Add technical details
    embed.fields!.push({
      name: "🔧 Technical Details",
      value: `TTL: ${context.ttl}s\nRecord Type: A\nChange Type: ${context.changeType.replace('_', ' ')}`,
      inline: true
    });

    if (soaData && soaData.length >= 3) {
      embed.fields!.push({
        name: "📋 SOA Information",
        value: `Serial: ${soaData[2]}\nPrimary NS: ${soaData[0] || 'unknown'}\nAdmin: ${soaData[1] || 'unknown'}`,
        inline: true
      });
    }

    // Add recommended actions based on context
    embed.fields!.push({
      name: "💡 Recommended Actions",
      value: this.getRecommendedActions(context, cdnInfo, lbInfo, timeInfo, coordinatedInfo),
      inline: false
    });

    return embed;
  }

  static buildAutoSuppressionNotification(
    domain: string,
    previousIPs: string[],
    currentIPs: string[],
    changeCount: number,
    cdnInfo: ReturnType<typeof IntelligentCDNDetector.detectProvider>,
    lbInfo: ReturnType<typeof LoadBalancerIntelligence.analyzePattern>
  ): DiscordEmbed {
    const embed: DiscordEmbed = {
      title: '🚫 DNS Auto-Suppression Activated',
      description: `Domain \`${domain}\` is changing too frequently - notifications suppressed for 4 hours`,
      color: 16763904, // Yellow/Warning
      fields: [
        {
          name: "🚫 Reason",
          value: `${changeCount} IP changes detected in the last hour`,
          inline: false
        },
        {
          name: "⏰ Suppression Duration", 
          value: "4 hours (auto-dampening)",
          inline: true
        },
        {
          name: "📋 Latest Change",
          value: `${previousIPs.join(", ")} → ${currentIPs.join(", ")}`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: "DNS Monitor - Auto-Suppression"
      }
    };

    // Add pattern-specific advice
    let actionAdvice = "Check if this domain uses load balancing or CDN";
    if (cdnInfo.isAnyCDN && cdnInfo.provider) {
      actionAdvice = `${cdnInfo.provider} CDN detected - consider domain-specific dampening rules`;
    } else if (lbInfo.isLoadBalancer) {
      actionAdvice = `${lbInfo.pattern} load balancing detected - consider increasing dampening period`;
    }

    embed.fields!.push({
      name: "🔧 Action Needed",
      value: actionAdvice,
      inline: true
    });

    embed.fields!.push({
      name: "💡 Note",
      value: "Use `/dampening` command to check status or clear manually",
      inline: false
    });

    return embed;
  }

  private static getSmartTitle(
    context: ChangeContext,
    cdnInfo: ReturnType<typeof IntelligentCDNDetector.detectProvider>,
    lbInfo: ReturnType<typeof LoadBalancerIntelligence.analyzePattern>,
    timeInfo: ReturnType<typeof TemporalAnalyzer.analyzeTimePatterns>,
    coordinatedInfo?: { isCoordinated: boolean; confidence: number; analysis: string; relatedDomains: string[] }
  ): string {
    if (coordinatedInfo?.isCoordinated) return '🌐 Coordinated Infrastructure Change Detected';
    if (context.severity === 'critical') return '🚨 Critical DNS Change Detected';
    if (lbInfo.isLoadBalancer && lbInfo.pattern === 'failover') return '🔄 Load Balancer Failover Detected';
    if (cdnInfo.isAnyCDN) return '🌐 CDN Configuration Change';
    if (timeInfo.isMaintenanceWindow) return '🔧 DNS Change During Maintenance Window';
    if (context.changeType === 'complete_change') return '⚡ Complete IP Address Change';
    return '📡 DNS Change Detected';
  }

  private static getSeverityColor(severity: string): number {
    switch (severity) {
      case 'critical': return 16711680; // Red
      case 'high': return 16753920;    // Orange 
      case 'medium': return 16776960;  // Yellow
      case 'low': return 5793266;      // Blue
      default: return 9807270;         // Gray
    }
  }

  private static buildAnalysisText(
    context: ChangeContext,
    cdnInfo: ReturnType<typeof IntelligentCDNDetector.detectProvider>,
    lbInfo: ReturnType<typeof LoadBalancerIntelligence.analyzePattern>,
    timeInfo: ReturnType<typeof TemporalAnalyzer.analyzeTimePatterns>
  ): string {
    const parts = [];
    
    parts.push(`**Change Type:** ${context.changeType.replace('_', ' ')}`);
    parts.push(`**Severity:** ${context.severity.toUpperCase()}`);
    parts.push(`**TTL:** ${context.ttl}s`);
    parts.push(`**Time Context:** ${timeInfo.timePattern.replace('_', ' ')}`);
    
    if (context.geoContext) {
      parts.push(`**Geographic:** ${context.geoContext.crossRegion ? 'Cross-region' : 'Same region'}`);
    }
    
    return parts.join('\n');
  }

  private static getRecommendedActions(
    context: ChangeContext,
    cdnInfo: ReturnType<typeof IntelligentCDNDetector.detectProvider>,
    lbInfo: ReturnType<typeof LoadBalancerIntelligence.analyzePattern>,
    timeInfo: ReturnType<typeof TemporalAnalyzer.analyzeTimePatterns>,
    coordinatedInfo?: { isCoordinated: boolean; confidence: number; analysis: string; relatedDomains: string[] }
  ): string {
    const actions = [];

    if (context.severity === 'critical') {
      actions.push('🚨 **Immediate attention required** - verify service availability');
    }

    if (lbInfo.isLoadBalancer) {
      if (lbInfo.pattern === 'failover') {
        actions.push('🔍 Check if this is planned failover or incident response');
      } else {
        actions.push(`📊 Normal ${lbInfo.pattern} load balancing - consider increasing dampening`);
      }
    }

    if (cdnInfo.isAnyCDN) {
      actions.push('🌐 CDN change detected - verify edge server health');
    }

    if (timeInfo.isMaintenanceWindow) {
      actions.push('🔧 Change during maintenance window - likely planned');
    } else if (timeInfo.isBusinessHours) {
      actions.push('⏰ Change during business hours - may need immediate attention');
    }

    if (context.changeType === 'complete_change') {
      actions.push('🔄 Complete IP change - verify domain ownership and DNS integrity');
    }

    if (coordinatedInfo?.isCoordinated) {
      actions.push(`🌐 **Coordinated change detected** - ${coordinatedInfo.relatedDomains.length + 1} domains affected simultaneously`);
      actions.push('📊 Review infrastructure-wide changes and consider longer dampening periods');
    }

    return actions.length > 0 ? actions.join('\n') : 'No specific actions required - monitor for additional changes';
  }
}

// Helper to create colored embeds based on notification type (backward compatibility)
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

// Enhanced CDN and Cloud Provider Detection
class IntelligentCDNDetector {
  private static readonly ENHANCED_CDN_RANGES = [
    // Cloudflare (comprehensive)
    { provider: 'Cloudflare', start: '104.16.0.0', end: '104.31.255.255' },
    { provider: 'Cloudflare', start: '172.64.0.0', end: '172.71.255.255' },
    { provider: 'Cloudflare', start: '108.162.192.0', end: '108.162.255.255' },
    { provider: 'Cloudflare', start: '190.93.240.0', end: '190.93.255.255' },
    { provider: 'Cloudflare', start: '188.114.96.0', end: '188.114.127.255' },
    
    // AWS CloudFront/ALB/ELB (expanded)
    { provider: 'AWS', start: '13.32.0.0', end: '13.35.255.255' },
    { provider: 'AWS', start: '13.224.0.0', end: '13.227.255.255' },
    { provider: 'AWS', start: '13.249.0.0', end: '13.249.255.255' },
    { provider: 'AWS', start: '52.84.0.0', end: '52.85.255.255' },
    { provider: 'AWS', start: '54.230.0.0', end: '54.239.255.255' },
    { provider: 'AWS', start: '204.246.164.0', end: '204.246.191.255' },
    { provider: 'AWS', start: '205.251.192.0', end: '205.251.255.255' },
    
    // Fastly
    { provider: 'Fastly', start: '23.235.32.0', end: '23.235.63.255' },
    { provider: 'Fastly', start: '151.101.0.0', end: '151.101.255.255' },
    { provider: 'Fastly', start: '199.232.0.0', end: '199.232.255.255' },
    
    // Google Cloud CDN/Load Balancer
    { provider: 'Google', start: '35.186.0.0', end: '35.191.255.255' },
    { provider: 'Google', start: '130.211.0.0', end: '130.211.255.255' },
    { provider: 'Google', start: '35.244.0.0', end: '35.247.255.255' },
    
    // Azure Front Door/Traffic Manager
    { provider: 'Azure', start: '40.90.0.0', end: '40.91.255.255' },
    { provider: 'Azure', start: '13.107.42.0', end: '13.107.43.255' },
    { provider: 'Azure', start: '204.79.197.0', end: '204.79.197.255' },
    
    // KeyCDN
    { provider: 'KeyCDN', start: '119.81.0.0', end: '119.81.255.255' },
    
    // MaxCDN/StackPath
    { provider: 'StackPath', start: '94.31.0.0', end: '94.31.255.255' },
    
    // Incapsula/Imperva
    { provider: 'Imperva', start: '149.126.72.0', end: '149.126.79.255' },
    { provider: 'Imperva', start: '185.11.124.0', end: '185.11.127.255' },
  ];

  static detectProvider(ips: string[]): { provider: string | null; confidence: number; isAnyCDN: boolean } {
    let matches = 0;
    let totalIPs = ips.length;
    let detectedProvider: string | null = null;
    
    for (const ip of ips) {
      const ipNum = this.ipToNumber(ip);
      for (const range of this.ENHANCED_CDN_RANGES) {
        if (ipNum >= this.ipToNumber(range.start) && ipNum <= this.ipToNumber(range.end)) {
          matches++;
          if (!detectedProvider) detectedProvider = range.provider;
          break;
        }
      }
    }
    
    const confidence = totalIPs > 0 ? matches / totalIPs : 0;
    return {
      provider: confidence > 0.5 ? detectedProvider : null,
      confidence,
      isAnyCDN: confidence > 0
    };
  }

  private static ipToNumber(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
  }
}

// Backward compatibility function
function isCDNOrCloudIP(ips: string[]): boolean {
  return IntelligentCDNDetector.detectProvider(ips).isAnyCDN;
}

function ipToNumber(ip: string): number {
  return IntelligentCDNDetector['ipToNumber'](ip);
}

// Advanced Load Balancer Pattern Detection
class LoadBalancerIntelligence {
  static analyzePattern(recentIPSets: Array<{ips: string[], timestamp: number}>): {
    isLoadBalancer: boolean;
    pattern: 'round_robin' | 'weighted' | 'failover' | 'geographic' | 'unknown';
    confidence: number;
    analysis: string;
  } {
    if (recentIPSets.length < 3) {
      return { isLoadBalancer: false, pattern: 'unknown', confidence: 0, analysis: 'Insufficient data' };
    }
    
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const recentSets = recentIPSets.filter(set => (now - set.timestamp) < oneHour);
    
    if (recentSets.length < 3) {
      return { isLoadBalancer: false, pattern: 'unknown', confidence: 0, analysis: 'Not enough recent changes' };
    }
    
    // Analyze patterns
    const uniqueIPSets = new Set(recentSets.map(set => set.ips.sort().join(',')));
    const uniqueCount = uniqueIPSets.size;
    const totalChanges = recentSets.length;
    
    // Round-robin pattern: Limited set of IPs rotating frequently
    if (totalChanges >= 5 && uniqueCount <= 3 && uniqueCount >= 2) {
      return {
        isLoadBalancer: true,
        pattern: 'round_robin',
        confidence: 0.8,
        analysis: `${totalChanges} changes between ${uniqueCount} IP sets suggests round-robin load balancing`
      };
    }
    
    // Weighted pattern: Some IPs appear more frequently
    if (uniqueCount >= 2 && uniqueCount <= 4) {
      const ipFrequency = new Map<string, number>();
      recentSets.forEach(set => {
        const key = set.ips.sort().join(',');
        ipFrequency.set(key, (ipFrequency.get(key) || 0) + 1);
      });
      
      const frequencies = Array.from(ipFrequency.values()).sort((a, b) => b - a);
      if (frequencies[0] > frequencies[1] * 1.5) {
        return {
          isLoadBalancer: true,
          pattern: 'weighted',
          confidence: 0.7,
          analysis: `Weighted distribution detected: primary IP set appears ${frequencies[0]} times vs ${frequencies[1]}`
        };
      }
    }
    
    // Failover pattern: Sudden switch from one IP to another
    if (recentSets.length >= 2) {
      const timeGaps = [];
      for (let i = 1; i < recentSets.length; i++) {
        timeGaps.push(recentSets[i].timestamp - recentSets[i-1].timestamp);
      }
      
      const avgGap = timeGaps.reduce((a, b) => a + b, 0) / timeGaps.length;
      const hasLargeGap = timeGaps.some(gap => gap > avgGap * 3);
      
      if (hasLargeGap && uniqueCount <= 2) {
        return {
          isLoadBalancer: true,
          pattern: 'failover',
          confidence: 0.6,
          analysis: 'Failover pattern: sudden switches with time gaps suggest failover behavior'
        };
      }
    }
    
    return { isLoadBalancer: false, pattern: 'unknown', confidence: 0, analysis: 'No clear load balancer pattern detected' };
  }
}

// Backward compatibility function
function detectLoadBalancerPattern(domain: string, recentIPSets: Array<{ips: string[], timestamp: number}>): boolean {
  return LoadBalancerIntelligence.analyzePattern(recentIPSets).isLoadBalancer;
}

// Time-based Intelligence
class TemporalAnalyzer {
  static analyzeTimePatterns(recentIPSets: Array<{ips: string[], timestamp: number}>): {
    isMaintenanceWindow: boolean;
    isBusinessHours: boolean;
    isWeekend: boolean;
    timePattern: string;
  } {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
    
    // Common maintenance windows: 2-6 AM UTC, 10 PM - 2 AM UTC
    const isMaintenanceWindow = (currentHour >= 2 && currentHour <= 6) || 
                               (currentHour >= 22 || currentHour <= 2);
    
    // Business hours: 8 AM - 6 PM UTC (rough global business hours)
    const isBusinessHours = currentHour >= 8 && currentHour <= 18 && !isWeekend;
    
    let timePattern = 'normal';
    if (isMaintenanceWindow) timePattern = 'maintenance_window';
    else if (!isBusinessHours) timePattern = 'off_hours';
    else if (isWeekend) timePattern = 'weekend';
    
    return {
      isMaintenanceWindow,
      isBusinessHours,
      isWeekend,
      timePattern
    };
  }
}

// Change Analysis Helper
class ChangeAnalyzer {
  static analyzeChange(previousIPs: string[], currentIPs: string[], ttl: number): ChangeContext {
    const now = Date.now();
    let changeType: ChangeContext['changeType'] = 'replacement';
    let severity: ChangeContext['severity'] = 'medium';
    
    // Determine change type
    if (previousIPs.length === 0) {
      changeType = 'addition';
    } else if (currentIPs.length === 0) {
      changeType = 'removal';
      severity = 'high'; // IP removal is usually significant
    } else if (previousIPs.length !== currentIPs.length || 
               !previousIPs.every(ip => currentIPs.includes(ip))) {
      if (previousIPs.every(ip => !currentIPs.includes(ip))) {
        changeType = 'complete_change';
        severity = 'high'; // Complete IP change is significant
      } else {
        changeType = 'replacement';
      }
    }
    
    // Determine severity based on change characteristics
    const timeInfo = TemporalAnalyzer.analyzeTimePatterns([]);
    if (changeType === 'complete_change' && timeInfo.isBusinessHours) {
      severity = 'critical';
    } else if (changeType === 'removal') {
      severity = 'high';
    } else if (timeInfo.isMaintenanceWindow) {
      severity = 'low';
    }
    
    return {
      timestamp: now,
      previousIPs,
      currentIPs,
      ttl,
      changeType,
      severity,
      confidence: 0.8 // Default confidence, can be adjusted by pattern detection
    };
  }
}

// Enhanced Dampening Calculator
class EnhancedDampeningCalculator {
  static calculateIntelligentDampening(
    domain: string,
    context: ChangeContext,
    cdnInfo: ReturnType<typeof IntelligentCDNDetector.detectProvider>,
    lbInfo: ReturnType<typeof LoadBalancerIntelligence.analyzePattern>,
    timeInfo: ReturnType<typeof TemporalAnalyzer.analyzeTimePatterns>,
    recentIPSets: Array<{ips: string[], timestamp: number}>
  ): {
    dampeningPeriod: number;
    reason: string;
    shouldNotify: boolean;
    nextNotificationTime: number;
  } {
    let baseDampening = this.getBaseDampening(context.ttl);
    let multiplier = 1;
    const reasons = [];

    // CDN adjustments
    if (cdnInfo.isAnyCDN) {
      if (cdnInfo.confidence > 0.8) {
        multiplier *= 2; // Strong CDN confidence = more dampening
        reasons.push(`CDN detected (${cdnInfo.provider || 'generic'})`);
      } else {
        multiplier *= 1.5;
        reasons.push('Possible CDN detected');
      }
    }

    // Load balancer adjustments
    if (lbInfo.isLoadBalancer) {
      switch (lbInfo.pattern) {
        case 'round_robin':
          multiplier *= 3; // Very aggressive dampening
          reasons.push('Round-robin load balancing');
          break;
        case 'weighted':
          multiplier *= 2;
          reasons.push('Weighted load balancing');
          break;
        case 'failover':
          multiplier *= 0.5; // Less dampening for failovers (more important)
          reasons.push('Failover detected - reduced dampening');
          break;
        default:
          multiplier *= 1.5;
          reasons.push('Load balancer pattern detected');
      }
    }

    // Time-based adjustments
    if (timeInfo.isMaintenanceWindow) {
      multiplier *= 1.5;
      reasons.push('Maintenance window');
    } else if (timeInfo.isBusinessHours) {
      multiplier *= 0.8; // Less dampening during business hours
      reasons.push('Business hours - priority notifications');
    }

    // Severity adjustments
    switch (context.severity) {
      case 'critical':
        multiplier *= 0.3; // Minimal dampening for critical changes
        reasons.push('Critical severity');
        break;
      case 'high':
        multiplier *= 0.6;
        reasons.push('High severity');
        break;
      case 'medium':
        multiplier *= 1;
        break;
      case 'low':
        multiplier *= 2;
        reasons.push('Low severity');
        break;
    }

    // Frequency-based adjustments
    const recentChanges = recentIPSets.filter(set => 
      (Date.now() - set.timestamp) < 60 * 60 * 1000 // Last hour
    );
    
    if (recentChanges.length >= 5) {
      multiplier *= 4; // Heavy dampening for very frequent changes
      reasons.push('High frequency changes');
    } else if (recentChanges.length >= 3) {
      multiplier *= 2;
      reasons.push('Moderate frequency changes');
    }

    const finalDampening = Math.round(baseDampening * multiplier);
    const maxDampening = 4 * 60 * 60 * 1000; // 4 hours max
    const minDampening = 1 * 60 * 1000; // 1 minute min for critical

    const clampedDampening = Math.min(Math.max(finalDampening, minDampening), maxDampening);

    return {
      dampeningPeriod: clampedDampening,
      reason: reasons.join(', '),
      shouldNotify: true, // Logic would check against last notification time
      nextNotificationTime: Date.now() + clampedDampening
    };
  }

  private static getBaseDampening(ttl: number): number {
    if (ttl < 60) return 20 * 60 * 1000; // 20 minutes
    if (ttl < 300) return 15 * 60 * 1000; // 15 minutes  
    if (ttl < 900) return Math.max(ttl * 2 * 1000, 5 * 60 * 1000); // 2x TTL or 5 min
    return Math.max(ttl * 1000, 5 * 60 * 1000); // 1x TTL or 5 min
  }
}

async function shouldSendDNSChangeNotification(
  env: Env, 
  domain: string, 
  currentIPs: string[], 
  ttl: number,
  previousIPs: string[] = []
): Promise<{ shouldNotify: boolean; context?: ChangeContext; analysis?: any }> {
  try {
    const now = Date.now();
    
    // Get last notification time for this domain
    const lastNotificationKey = `notify:${domain}:last`;
    const lastNotificationTime = await env.DNS_KV.get(lastNotificationKey);
    const lastNotifyTime = lastNotificationTime ? parseInt(lastNotificationTime) : 0;
    
    // Get recent IP sets for this domain (track oscillation)
    const recentIPsKey = `notify:${domain}:recent_ips`;
    const recentIPsData = await env.DNS_KV.get(recentIPsKey);
    const recentIPSets: Array<{ips: string[], timestamp: number}> = recentIPsData ? JSON.parse(recentIPsData) : [];
    
    // Enhanced pattern detection
    const cdnInfo = IntelligentCDNDetector.detectProvider(currentIPs);
    let lbInfo = LoadBalancerIntelligence.analyzePattern(recentIPSets);
    const timeInfo = TemporalAnalyzer.analyzeTimePatterns(recentIPSets);
    let context = ChangeAnalyzer.analyzeChange(previousIPs, currentIPs, ttl);
    
    // Cross-domain coordinated change detection (for cases with insufficient single-domain history)
    let coordinatedInfo: { isCoordinated: boolean; confidence: number; analysis: string; relatedDomains: string[] } | undefined;
    if (!lbInfo.isLoadBalancer && recentIPSets.length < 3) {
      coordinatedInfo = await detectCoordinatedInfrastructureChange(env, domain, currentIPs, now);
      if (coordinatedInfo.isCoordinated) {
        lbInfo = {
          isLoadBalancer: true,
          pattern: 'round_robin',
          confidence: coordinatedInfo.confidence,
          analysis: coordinatedInfo.analysis
        };
        // Upgrade severity for coordinated changes
        context = { ...context, severity: 'high' as const };
        console.log(`🌐 Coordinated infrastructure change detected for ${domain}: ${coordinatedInfo.analysis}`);
      }
    }
    
    // Enhanced oscillation detection
    const currentIPSet = currentIPs.sort().join(',');
    const recentIPSet = recentIPSets.find(set => 
      set.ips.sort().join(',') === currentIPSet && 
      (now - set.timestamp) < 24 * 60 * 60 * 1000 // Within last 24 hours
    );
    
    if (recentIPSet && recentIPSets.length > 1) {
      const minutesAgo = Math.round((now - recentIPSet.timestamp) / (60 * 1000));
      console.log(`🔄 Oscillation detected for ${domain}: IP set seen ${minutesAgo} minutes ago`);
      
      // For oscillating IPs, use much longer dampening period
      let oscillationDampening;
      if (cdnInfo.isAnyCDN || lbInfo.isLoadBalancer) {
        oscillationDampening = 2 * 60 * 60 * 1000; // 2 hours for CDN/LB oscillation
      } else {
        oscillationDampening = 30 * 60 * 1000; // 30 minutes for others
      }
      
      const timeSinceLastNotify = now - lastNotifyTime;
      if (timeSinceLastNotify < oscillationDampening) {
        const remainingOsc = Math.round((oscillationDampening - timeSinceLastNotify) / (60 * 1000));
        console.log(`🔇 Oscillation dampening for ${domain}: ${remainingOsc} minutes remaining`);
        await updateRecentIPTracking(env, domain, currentIPs, now);
        return { shouldNotify: false };
      }
    }
    
    // Auto-suppress very frequent changers (enhanced with coordinated change detection)
    const recentChanges = recentIPSets.filter(set => (now - set.timestamp) < 60 * 60 * 1000); // Last hour
    const suppressionThreshold = lbInfo.isLoadBalancer ? 3 : 5; // Lower threshold for detected load balancers
    
    if (recentChanges.length >= suppressionThreshold) {
      console.log(`🚫 Auto-suppressing ${domain}: ${recentChanges.length} changes in last hour (threshold: ${suppressionThreshold})`);
      
      // Set a long dampening period automatically
      const autoSuppressPeriod = 4 * 60 * 60 * 1000; // 4 hours
      await env.DNS_KV.put(lastNotificationKey, now.toString(), { expirationTtl: 7 * 24 * 60 * 60 });
      await updateRecentIPTracking(env, domain, currentIPs, now);
      
      // Send one final notification about auto-suppression
      console.log(`📢 Sending auto-suppression notice for ${domain}`);
      return { 
        shouldNotify: true, 
        context: { ...context, severity: 'high' as const, changeType: 'complete_change' as const },
        analysis: { 
          isAutoSuppression: true, 
          changeCount: recentChanges.length,
          cdnInfo, 
          lbInfo, 
          timeInfo 
        }
      };
    }
    
    // Calculate intelligent dampening
    const dampeningResult = EnhancedDampeningCalculator.calculateIntelligentDampening(
      domain, context, cdnInfo, lbInfo, timeInfo, recentIPSets
    );
    
    // Check if enough time has passed since last notification
    const timeSinceLastNotify = now - lastNotifyTime;
    if (timeSinceLastNotify < dampeningResult.dampeningPeriod) {
      const remaining = Math.round((dampeningResult.dampeningPeriod - timeSinceLastNotify) / (60 * 1000));
      console.log(`🔇 Intelligent dampening active for ${domain}: ${remaining} minutes remaining (${dampeningResult.reason})`);
      
      // Still update recent IPs tracking without notifying
      await updateRecentIPTracking(env, domain, currentIPs, now);
      return { shouldNotify: false };
    }
    
    // Should send notification - update tracking
    await env.DNS_KV.put(lastNotificationKey, now.toString(), { expirationTtl: 7 * 24 * 60 * 60 }); // 7 days
    await updateRecentIPTracking(env, domain, currentIPs, now);
    
    console.log(`✅ Sending intelligent DNS change notification for ${domain} (${dampeningResult.reason})`);
    return { 
      shouldNotify: true, 
      context,
      analysis: { 
        isAutoSuppression: false,
        cdnInfo, 
        lbInfo, 
        timeInfo,
        dampeningReason: dampeningResult.reason,
        coordinatedInfo
      }
    };
    
  } catch (error) {
    console.error(`Error in enhanced dampening logic for ${domain}:`, error);
    // On error, err on the side of sending notifications
    return { shouldNotify: true };
  }
}

async function updateRecentIPTracking(env: Env, domain: string, currentIPs: string[], timestamp: number): Promise<void> {
  try {
    const recentIPsKey = `notify:${domain}:recent_ips`;
    const recentIPsData = await env.DNS_KV.get(recentIPsKey);
    let recentIPSets: Array<{ips: string[], timestamp: number}> = recentIPsData ? JSON.parse(recentIPsData) : [];
    
    // Add current IP set
    recentIPSets.push({ ips: currentIPs.sort(), timestamp });
    
    // Keep only last 10 IP sets and remove old ones (> 7 days)
    const sevenDaysAgo = timestamp - (7 * 24 * 60 * 60 * 1000);
    recentIPSets = recentIPSets
      .filter(set => set.timestamp > sevenDaysAgo)
      .slice(-10); // Keep last 10
    
    await env.DNS_KV.put(recentIPsKey, JSON.stringify(recentIPSets), { expirationTtl: 7 * 24 * 60 * 60 }); // 7 days
  } catch (error) {
    console.error(`Error updating recent IP tracking for ${domain}:`, error);
  }
}

// Cross-domain coordinated change detection
async function detectCoordinatedInfrastructureChange(
  env: Env, 
  domain: string, 
  currentIPs: string[], 
  timestamp: number
): Promise<{ isCoordinated: boolean; confidence: number; analysis: string; relatedDomains: string[] }> {
  try {
    const baseDomain = domain.includes('.') ? domain.split('.').slice(-2).join('.') : domain;
    const timeWindow = 10 * 60 * 1000; // 10 minutes
    const recentChangeThreshold = timestamp - timeWindow;
    
    // Track this change globally
    const globalChangesKey = `global:dns_changes:${Math.floor(timestamp / (5 * 60 * 1000))}`; // 5-minute buckets
    const globalChangesData = await env.DNS_KV.get(globalChangesKey);
    const globalChanges: Array<{domain: string, ips: string[], timestamp: number}> = 
      globalChangesData ? JSON.parse(globalChangesData) : [];
    
    // Add current change
    globalChanges.push({ domain, ips: currentIPs.sort(), timestamp });
    
    // Store updated global changes (expire after 1 hour)
    await env.DNS_KV.put(globalChangesKey, JSON.stringify(globalChanges), { expirationTtl: 60 * 60 });
    
    // Analyze recent changes for coordination patterns
    const recentGlobalChanges = globalChanges.filter(change => change.timestamp > recentChangeThreshold);
    const relatedDomains = recentGlobalChanges
      .filter(change => {
        const changeBaseDomain = change.domain.includes('.') ? 
          change.domain.split('.').slice(-2).join('.') : change.domain;
        return changeBaseDomain === baseDomain && change.domain !== domain;
      })
      .map(change => change.domain);
    
    if (relatedDomains.length === 0) {
      return { isCoordinated: false, confidence: 0, analysis: 'No related domain changes', relatedDomains: [] };
    }
    
    // Check for IP range overlaps (suggests same infrastructure)
    const allRecentIPs = new Set<string>();
    recentGlobalChanges.forEach(change => change.ips.forEach(ip => allRecentIPs.add(ip)));
    const currentIPSet = new Set(currentIPs);
    const ipOverlap = Array.from(allRecentIPs).filter(ip => currentIPSet.has(ip)).length;
    const ipOverlapRatio = ipOverlap / Math.max(allRecentIPs.size, currentIPs.length);
    
    // Coordinated change criteria
    const coordinationScore = Math.min(1, (relatedDomains.length * 0.3) + (ipOverlapRatio * 0.7));
    const isCoordinated = relatedDomains.length >= 2 && coordinationScore > 0.6;
    
    if (isCoordinated) {
      return {
        isCoordinated: true,
        confidence: coordinationScore,
        analysis: `${relatedDomains.length + 1} related ${baseDomain} domains changed within ${Math.round(timeWindow / (60 * 1000))} minutes, ${Math.round(ipOverlapRatio * 100)}% IP overlap suggests coordinated infrastructure change`,
        relatedDomains
      };
    }
    
    return { 
      isCoordinated: false, 
      confidence: coordinationScore, 
      analysis: `${relatedDomains.length} related changes but insufficient coordination score (${Math.round(coordinationScore * 100)}%)`,
      relatedDomains 
    };
    
  } catch (error) {
    console.error(`Error detecting coordinated changes for ${domain}:`, error);
    return { isCoordinated: false, confidence: 0, analysis: 'Error in coordination detection', relatedDomains: [] };
  }
}

// Note: sendAutoSuppressionNotification function replaced by IntelligentNotificationBuilder.buildAutoSuppressionNotification

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

    // Check if this is the first time monitoring this domain
    const isFirstTimeMonitoring = !previousState && !previousIPs && !previousSerial;
    
    // Get TTL for dampening logic
    const ttl = aRecords[0]?.TTL || 300;
    
    // If the IPs have changed
    if (JSON.stringify(previousIPsArray) !== JSON.stringify(currentIPs)) {
      await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
      await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);

      if (isFirstTimeMonitoring) {
        // First time monitoring - store initial state without notification
        console.log(`🔍 First time monitoring ${domain}:`);
        console.log(`Initial IPs: ${currentIPs.join(", ")}`);
        console.log(`SOA Serial: ${serial}`);
        console.log(`Timestamp: ${new Date().toISOString()}`);
      } else {
        // Check if we should send a notification using enhanced dampening logic
        const dampeningResult = await shouldSendDNSChangeNotification(env, domain, currentIPs, ttl, previousIPsArray);
        
        if (dampeningResult.shouldNotify) {
          let embed: DiscordEmbed;
          
          if (dampeningResult.analysis?.isAutoSuppression) {
            // This is the auto-suppression notification
            embed = IntelligentNotificationBuilder.buildAutoSuppressionNotification(
              domain, 
              previousIPsArray, 
              currentIPs, 
              dampeningResult.analysis.changeCount,
              dampeningResult.analysis.cdnInfo,
              dampeningResult.analysis.lbInfo
            );
          } else if (dampeningResult.context && dampeningResult.analysis) {
            // Enhanced intelligent notification
            embed = IntelligentNotificationBuilder.buildEnhancedNotification(
              domain,
              previousIPsArray,
              currentIPs,
              dampeningResult.context,
              dampeningResult.analysis.cdnInfo,
              dampeningResult.analysis.lbInfo,
              dampeningResult.analysis.timeInfo,
              soaData,
              dampeningResult.analysis.coordinatedInfo
            );
          } else {
            // Fallback to basic notification
            embed = createEmbed('change', 'DNS Change Detected');
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
                value: `${ttl}`,
                inline: true
              },
              {
                name: "DNS Status",
                value: `${dnsData.Status}`,
                inline: true
              },
              {
                name: "SOA Serial",
                value: serial,
                inline: true
              }
            ];
          }

          // Only add role mention if DISCORD_ROLE_ID is set
          const mentionContent = env.DISCORD_ROLE_ID ? `<@&${env.DISCORD_ROLE_ID}>` : ``;
          await sendDiscordMessage(env, embed, mentionContent);
          
          console.log(`✅ Enhanced DNS change notification sent for ${domain}:`);
          console.log(`Previous IPs: ${previousIPs || "none"}`);
          console.log(`New IPs: ${currentIPs.join(", ")}`);
          console.log(`SOA Serial: ${serial}`);
          console.log(`Severity: ${dampeningResult.context?.severity || 'unknown'}`);
          console.log(`Timestamp: ${new Date().toISOString()}`);
        } else {
          console.log(`🔇 DNS change detected for ${domain} but notification intelligently dampened`);
          console.log(`Previous IPs: ${previousIPs || "none"}`);
          console.log(`New IPs: ${currentIPs.join(", ")}`);
          console.log(`Reason: Enhanced pattern detection and context analysis`);
        }
      }
    } else if (serial !== previousSerial) {
      // Only notify on SOA changes if IPs haven't changed
      // This catches cases where other record types changed
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);

      if (!isFirstTimeMonitoring) {
        // Only send SOA notifications for domains that were already being monitored
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
      }
      
      console.log(`SOA record ${isFirstTimeMonitoring ? 'initialized' : 'updated'} for ${domain}:`);
      console.log(`Previous Serial: ${previousSerial || "unknown"}`);
      console.log(`New Serial: ${serial}`);
    } else if (isFirstTimeMonitoring) {
      // First time monitoring and no changes detected - just store initial state
      await env.DNS_KV.put(`dns:${domain}:state`, "resolved");
      await env.DNS_KV.put(`dns:${domain}:ips`, currentIPs.join(","));
      await env.DNS_KV.put(`dns:${domain}:serial`, serial);
      
      console.log(`🔍 First time monitoring ${domain} - storing initial state:`);
      console.log(`IPs: ${currentIPs.join(", ")}`);
      console.log(`SOA Serial: ${serial}`);
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

// Note: Cloudflare Workers cannot maintain persistent WebSocket connections
// required for Discord bot presence. The bot will appear offline in Discord
// but will still respond to slash commands perfectly.

async function updateBotDescription(env: Env, totalDomains: number, lastCheckTime: string): Promise<boolean> {
  try {
    const checkTime = new Date(lastCheckTime);
    const timeString = checkTime.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: 'UTC'
    });
    
    // Update the application description instead of presence
    // This shows up in the bot's profile and when hovering over the bot
    const description = `DNS Monitor Bot - Watching ${totalDomains} domains | Last check: ${timeString} UTC | Click for commands: /help`;
    
    const response = await fetch(`https://discord.com/api/v10/applications/@me`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        description: description.substring(0, 400) // Discord has a 400 char limit
      })
    });
    
    if (response.ok) {
      console.log(`✅ Bot description updated: ${description}`);
      return true;
    } else {
      const errorText = await response.text();
      console.log(`⚠️ Failed to update bot description: ${errorText}`);
      return false;
    }
  } catch (error) {
    console.error("Error updating bot description:", error);
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
    
         // Try to update Discord bot description (since presence requires persistent connection)
     console.log(`Attempting to update Discord bot description: ${activityName}`);
     
     try {
       const descriptionUpdated = await updateBotDescription(env, totalDomains, lastCheckTime);
       if (descriptionUpdated) {
         console.log(`✅ Discord bot description updated successfully`);
       } else {
         console.log(`⚠️ Discord bot description update failed, status stored in KV only`);
       }
     } catch (descriptionError) {
       console.error("Error updating Discord bot description:", descriptionError);
       console.log(`⚠️ Description update failed, but status stored in KV: ${activityName}`);
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

// Certificate Transparency API response structure
interface CTLogEntry {
  name_value: string;
  common_name: string;
  not_before: string;
  not_after: string;
  issuer_name: string;
}

async function discoverSubdomainsFromCT(domain: string, quickMode: boolean = false): Promise<string[]> {
  const allSubdomains = new Set<string>();
  
  // Multiple CT sources for comprehensive coverage
  const ctSources = [
    `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
    `https://crt.sh/?q=%.${encodeURIComponent(domain)}&output=json`
  ];
  
  // Add third source if not in quick mode
  if (!quickMode) {
    ctSources.push(`https://crt.sh/?q=${encodeURIComponent(domain)}&deduplicate=Y&output=json`);
  }
  
  const timeout = quickMode ? 1000 : 8000; // Very aggressive timeout for quick mode (1s)
  const maxResults = quickMode ? 50 : 1000; // Even fewer results in quick mode
  
  console.log(`🔍 Querying Certificate Transparency logs for ${domain} (${quickMode ? 'quick' : 'thorough'} mode)...`);
  
  for (const [index, ctUrl] of ctSources.entries()) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      try {
        console.log(`📡 Querying CT source ${index + 1}/${ctSources.length}: ${ctUrl.includes('%.') ? 'wildcard' : 'exact'} search`);
        
        const response = await fetch(ctUrl, {
          headers: {
            'User-Agent': 'DNS-Monitor-Bot/1.0'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.error(`CT API error (source ${index + 1}): ${response.status} ${response.statusText}`);
          continue;
        }

        const certificates: CTLogEntry[] = await response.json();
        console.log(`📜 Found ${certificates.length} certificates from source ${index + 1}`);

        // Process all certificates (or limit for quick mode)
        const certsToProcess = quickMode ? certificates.slice(0, 1000) : certificates;

        for (const cert of certsToProcess) {
          // Extract domains from both common_name and name_value (SAN)
          const domains = cert.name_value.split('\n').concat([cert.common_name]);
          
          for (let certDomain of domains) {
            certDomain = certDomain.trim().toLowerCase();
            
            // Skip wildcards and invalid entries
            if (certDomain.startsWith('*') || !certDomain.includes('.')) {
              continue;
            }
            
            // Check if it's a subdomain of our target domain
            if (certDomain.endsWith(`.${domain}`) || certDomain === domain) {
              // Validate domain format
              if (isValidDomain(certDomain)) {
                allSubdomains.add(certDomain);
              }
            }
          }
          
          // Stop if we've found enough for quick mode
          if (quickMode && allSubdomains.size > maxResults) {
            console.log(`⚠️ Quick mode: Found ${allSubdomains.size} domains, stopping early`);
            break;
          }
        }

      } catch (fetchError: unknown) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          console.log(`⏰ CT source ${index + 1} timeout after ${timeout}ms`);
        } else {
          console.error(`CT source ${index + 1} fetch error:`, fetchError);
        }
      }
      
    } catch (error) {
      console.error(`Error with CT source ${index + 1}:`, error);
    }
  }

  const result = Array.from(allSubdomains).sort();
  console.log(`✅ Discovered ${result.length} unique domains from ${ctSources.length} CT sources`);
  return result;
}



async function discoverSubdomainsFromDNS(domain: string): Promise<string[]> {
  console.log(`🔍 Trying DNS enumeration for ${domain}...`);
  const discovered = new Set<string>();
  
  // Try common enumeration techniques
  const commonPrefixes = ['www', 'mail', 'ftp', 'admin', 'test', 'dev', 'api', 'app'];
  
  for (const prefix of commonPrefixes) {
    try {
      const subdomain = `${prefix}.${domain}`;
      if (await checkSubdomainExists(subdomain)) {
        discovered.add(subdomain);
        console.log(`✅ DNS enum found: ${subdomain}`);
      }
      
      // Small delay to avoid overwhelming DNS servers
      await new Promise(resolve => setTimeout(resolve, 20));
    } catch (error) {
      // Continue on errors
    }
  }
  
  return Array.from(discovered);
}

// Enhanced fallback subdomain list (used when CT lookup fails)
const FALLBACK_SUBDOMAINS = [
  // Essential/Common
  'www', 'api', 'app', 'mobile', 'm', 'wap',
  
  // Infrastructure
  'mail', 'smtp', 'pop', 'imap', 'webmail', 'email',
  'dns', 'ns', 'ns1', 'ns2', 'ns3', 'ns4',
  'ftp', 'sftp', 'ssh', 'vpn',
  
  // Content/Media
  'cdn', 'static', 'assets', 'img', 'images', 'media',
  'css', 'js', 'fonts', 'files', 'downloads',
  
  // Services
  'admin', 'dashboard', 'panel', 'cp', 'control',
  'portal', 'secure', 'login', 'auth', 'sso',
  'account', 'user', 'users', 'profile',
  
  // Development
  'dev', 'development', 'staging', 'stage', 'test',
  'testing', 'qa', 'uat', 'sandbox', 'demo',
  'beta', 'alpha', 'preview', 'pre',
  
  // Business
  'blog', 'news', 'forum', 'forums', 'community',
  'shop', 'store', 'cart', 'checkout', 'payment',
  'support', 'help', 'docs', 'documentation',
  'wiki', 'kb', 'knowledge', 'faq',
  
  // Subdomains by service
  'status', 'monitoring', 'health', 'ping',
  'search', 'find', 'directory', 'listing',
  'upload', 'share', 'cloud', 'drive',
  
  // Geographic/Language
  'en', 'us', 'uk', 'ca', 'au', 'eu',
  'de', 'fr', 'es', 'it', 'nl', 'se',
  'asia', 'na', 'emea',
  
  // Technical
  'git', 'svn', 'ci', 'cd', 'jenkins', 'build',
  'monitor', 'metrics', 'logs', 'analytics',
  'tracking', 'stats', 'data'
];

async function checkSubdomainExists(subdomain: string): Promise<boolean> {
  try {
    const server = "https://1.1.1.1/dns-query";
    const url = new URL(server);
    url.searchParams.append("name", subdomain);
    url.searchParams.append("type", "A");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/dns-json",
      },
    });

    if (!response.ok) {
      return false;
    }

    const dnsData: DNSResponse = await response.json();
    
    // Check if we got A records and no errors
    return dnsData.Status === 0 && 
           dnsData.Answer !== undefined && 
           dnsData.Answer.length > 0 &&
           dnsData.Answer.some(record => record.type === 1); // A record
  } catch (error) {
    console.error(`Error checking subdomain ${subdomain}:`, error);
    return false;
  }
}

async function discoverSubdomains(domain: string, env: Env, verifyAll: boolean = false): Promise<{
  existing: string[];
  added: string[];
  skipped: string[];
  errors: string[];
}> {
  const result = {
    existing: [] as string[],
    added: [] as string[],
    skipped: [] as string[],
    errors: [] as string[]
  };

  // Get current dynamic domains to check for duplicates
  const currentDomains = await getDynamicDomains(env);
  
  try {
    // More aggressive settings for quick mode
    const quickMode = !verifyAll;
    const maxDiscoveryTime = quickMode ? 3000 : 15000; // 3s for quick mode
    const maxDomains = quickMode ? 25 : 500; // Even fewer domains for quick mode
    
    console.log(`🔍 Starting subdomain discovery for ${domain} (${quickMode ? 'quick' : 'thorough'} mode)`);
    const discoveryStartTime = Date.now();
    
    let allDiscoveredDomains = new Set<string>();
    
    if (quickMode) {
      // Quick mode: Run discovery methods in parallel with aggressive timeouts
      console.log(`⚡ Quick mode: Running parallel discovery with 2s timeout`);
      
      const discoveryPromises = [
        // CT discovery with very short timeout
        discoverSubdomainsFromCT(domain, true).catch(error => {
          console.log(`CT discovery failed: ${error.message}`);
          return [];
        }),
        
                 // Fallback wordlist immediately available (top priority subdomains only)
         Promise.resolve(['www', 'api', 'app', 'mail', 'cdn', 'static', 'admin', 'dev', 'test', 'staging'].map(sub => `${sub}.${domain}`))
      ];
      
      try {
        // Race all discovery methods with 2-second timeout
        const discoveryResults = await Promise.race([
          Promise.allSettled(discoveryPromises),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Discovery methods timeout')), 2000)
          )
        ]);
        
        // Combine results from all successful methods
        for (const promiseResult of discoveryResults) {
          if (promiseResult.status === 'fulfilled') {
            promiseResult.value.forEach(d => allDiscoveredDomains.add(d));
          }
        }
        
        console.log(`⚡ Quick discovery found ${allDiscoveredDomains.size} domains`);
        
      } catch (error) {
                 console.log(`⚡ Quick discovery timeout, using minimal fallback`);
         // Use minimal fallback if everything fails
         ['www', 'api', 'app', 'mail', 'cdn'].forEach(sub => 
           allDiscoveredDomains.add(`${sub}.${domain}`)
         );
      }
      
    } else {
      // Thorough mode: Sequential with longer timeouts
      try {
        console.log(`📡 Thorough: Certificate Transparency discovery`);
        const ctDomains = await discoverSubdomainsFromCT(domain, false);
        ctDomains.forEach(d => allDiscoveredDomains.add(d));
        console.log(`✅ CT discovery found ${ctDomains.length} domains`);
      } catch (error) {
        console.error('CT discovery failed:', error);
      }
      
      // DNS enumeration if we have time
      if (Date.now() - discoveryStartTime < maxDiscoveryTime / 2) {
        try {
          console.log(`📡 Thorough: DNS enumeration`);
          const dnsDomains = await discoverSubdomainsFromDNS(domain);
          dnsDomains.forEach(d => allDiscoveredDomains.add(d));
          console.log(`✅ DNS enumeration found ${dnsDomains.length} additional domains`);
        } catch (error) {
          console.error('DNS enumeration failed:', error);
        }
      }
      
      // Fallback if nothing found
      if (allDiscoveredDomains.size === 0) {
        console.log(`📡 Using comprehensive fallback wordlist`);
        FALLBACK_SUBDOMAINS.forEach(sub => allDiscoveredDomains.add(`${sub}.${domain}`));
      }
    }
    
    // Always include root domain
    allDiscoveredDomains.add(domain);
    
    // Convert to array and apply aggressive limits for quick mode
    let discoveredDomains = Array.from(allDiscoveredDomains);
    
    if (discoveredDomains.length > maxDomains) {
      console.log(`⚠️ Found ${discoveredDomains.length} domains, limiting to ${maxDomains}`);
      // Prioritize: root domain first, then shorter domains
      discoveredDomains = discoveredDomains
        .sort((a, b) => {
          if (a === domain) return -1;
          if (b === domain) return 1;
          return a.length - b.length;
        })
        .slice(0, maxDomains);
    }

    console.log(`📋 Processing ${discoveredDomains.length} discovered domains`);

    // Process domains with different strategies for quick vs thorough mode
    for (const checkDomain of discoveredDomains) {
      // Aggressive timeout check
      if (Date.now() - discoveryStartTime > maxDiscoveryTime) {
        console.log(`⏰ Discovery timeout after ${maxDiscoveryTime}ms`);
        break;
      }
      
      try {
        // Skip if already being monitored
        if (currentDomains.includes(checkDomain)) {
          result.existing.push(checkDomain);
          continue;
        }

        let shouldAdd = false;
        
        if (quickMode) {
          // Quick mode: Add everything without verification to save time
          shouldAdd = true;
        } else if (!verifyAll && allDiscoveredDomains.size > 15) {
          // Thorough mode but large set: skip verification for speed
          shouldAdd = true;
        } else {
          // Full verification mode
          try {
            const exists = await Promise.race([
              checkSubdomainExists(checkDomain),
              new Promise<boolean>((_, reject) => 
                setTimeout(() => reject(new Error('DNS timeout')), 1500)
              )
            ]);
            shouldAdd = exists;
          } catch (dnsError) {
            // On timeout, assume it exists to avoid losing domains
            shouldAdd = true;
          }
        }
        
        if (shouldAdd) {
          result.added.push(checkDomain);
        } else {
          result.skipped.push(checkDomain);
        }
        
        // No delays in quick mode
        if (!quickMode) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
      } catch (error) {
        result.errors.push(checkDomain);
        console.error(`❌ Error processing ${checkDomain}:`, error);
      }
    }

    const duration = Math.round((Date.now() - discoveryStartTime) / 1000);
    console.log(`🎯 Discovery complete (${duration}s): ${result.added.length} new, ${result.existing.length} existing`);

  } catch (error) {
    console.error('Error in subdomain discovery:', error);
    result.errors.push(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
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
       },
       {
         name: "ℹ️ Note",
         value: "Initial DNS state will be recorded on next check without triggering alerts",
         inline: false
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

async function performRemoveWithSubdomainsAsync(interaction: DiscordInteraction, env: Env, domain: string): Promise<void> {
  const followupUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  
  try {
    const domains = await getDynamicDomains(env);
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
    
    // Find all domains that match the target domain or are subdomains of it
    const toRemove: string[] = [];
    const staticMatches: string[] = [];
    
    // Check dynamic domains
    for (const d of domains) {
      if (d === domain || d.endsWith(`.${domain}`)) {
        toRemove.push(d);
      }
    }
    
    // Check if any static domains would match (can't remove these)
    for (const d of staticDomains) {
      if (d === domain || d.endsWith(`.${domain}`)) {
        staticMatches.push(d);
      }
    }
    
    if (toRemove.length === 0 && staticMatches.length === 0) {
      await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `❌ No domains found matching \`${domain}\` or its subdomains.`
        })
      });
      return;
    }
    
    if (toRemove.length === 0 && staticMatches.length > 0) {
      await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `❌ Found ${staticMatches.length} matching static domain(s) but they cannot be removed via Discord commands. Static domains: ${staticMatches.map(d => `\`${d}\``).join(', ')}`
        })
      });
      return;
    }
    
    // Remove the matching domains
    const filteredDomains = domains.filter(d => !toRemove.includes(d));
    
    // Save updated list
    await saveDynamicDomains(env, filteredDomains);

    // Clean up stored DNS data for all removed domains
    const keysToDelete: string[] = [];
    for (const removedDomain of toRemove) {
      keysToDelete.push(
        `dns:${removedDomain}:ips`,
        `dns:${removedDomain}:serial`, 
        `dns:${removedDomain}:state`,
        `notify:${removedDomain}:last`,
        `notify:${removedDomain}:recent_ips`
      );
    }
    
    // Delete keys in batches to avoid timeout
    for (const key of keysToDelete) {
      try {
        await env.DNS_KV.delete(key);
      } catch (error) {
        console.error(`Failed to delete key ${key}:`, error);
      }
    }

    // Update bot status
    const totalDomains = staticDomains.length + filteredDomains.length;
    await updateBotStatus(env, totalDomains, new Date().toISOString());

    const embed = createEmbed('update', 'Domain and Subdomains Removed');
    embed.description = `Successfully removed \`${domain}\` and all its subdomains from DNS monitoring`;
    
    const fields = [];
    
    // Show removed domains
    if (toRemove.length > 0) {
      const removedText = toRemove.length > 15 
        ? `${toRemove.slice(0, 10).map(d => `\`${d}\``).join(", ")} and ${toRemove.length - 10} more...`
        : toRemove.map(d => `\`${d}\``).join(", ");
      
      fields.push({
        name: `🗑️ Removed (${toRemove.length})`,
        value: removedText,
        inline: false
      });
    }
    
    // Show static domains that couldn't be removed
    if (staticMatches.length > 0) {
      fields.push({
        name: `⚠️ Static Domains (${staticMatches.length}) - Not Removed`,
        value: staticMatches.map(d => `\`${d}\``).join(", "),
        inline: false
      });
    }
    
    fields.push({
      name: "📊 Summary",
      value: `**Removed:** ${toRemove.length} domains\n**Total Domains:** ${totalDomains} (was ${totalDomains + toRemove.length})\n**Removed By:** ${interaction.member?.user?.username || interaction.user?.username || "Unknown"}`,
      inline: false
    });

    embed.fields = fields;

    // Send results as followup
    await fetch(followupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });
    
  } catch (error) {
    console.error("Error removing domains:", error);
    
    // Send error as followup
    try {
      await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `❌ Failed to remove domains: ${error instanceof Error ? error.message : String(error)}`
        })
      });
    } catch (followupError) {
      console.error("Failed to send followup error:", followupError);
    }
  }
}

async function handleRemoveWithSubdomains(interaction: DiscordInteraction, env: Env, ctx?: ExecutionContext): Promise<DiscordInteractionResponse> {
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

  if (!isValidDomain(domain)) {
    return {
      type: 4,
      data: {
        content: `❌ Invalid domain format: \`${domain}\``,
        flags: 64
      }
    };
  }

  if (ctx) {
    // Use proper execution context to ensure async work completes
    ctx.waitUntil(performRemoveWithSubdomainsAsync(interaction, env, domain));
  } else {
    // Fallback: start async work immediately
    performRemoveWithSubdomainsAsync(interaction, env, domain).catch(error => {
      console.error("Background remove with subdomains failed:", error);
    });
  }

  // Return deferred response IMMEDIATELY
  return {
    type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: {}
  };
}

async function performListDomainsAsync(interaction: DiscordInteraction, env: Env): Promise<void> {
  const followupUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  
  console.log("🔍 Starting performListDomainsAsync...");
  
  try {
    console.log("📋 Getting dynamic domains...");
    const dynamicDomains = await getDynamicDomains(env);
    console.log(`📋 Dynamic domains retrieved: ${dynamicDomains.length} domains`);
    
    console.log("📋 Processing static domains...");
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
    console.log(`📋 Static domains processed: ${staticDomains.length} domains`);
    
    console.log("🎨 Creating embeds...");
    const embeds = [];
    
    if (dynamicDomains.length === 0 && staticDomains.length === 0) {
      console.log("📋 No domains to display");
      const embed = createEmbed('update', 'Monitored Domains');
      embed.description = "No domains are currently being monitored.";
      embeds.push(embed);
    } else {
      console.log("📋 Building domain list display with multiple embeds...");
      
      // Helper function to create domain list chunks that fit within Discord's 1024 char limit
      function createDomainChunks(domains: string[], prefix: string): string[] {
        const chunks: string[] = [];
        let currentChunk = "";
        
        for (const domain of domains) {
          const domainText = `\`${domain}\``;
          const separator = currentChunk ? ", " : "";
          const testChunk = currentChunk + separator + domainText;
          
          // Keep some buffer for the prefix and formatting (leave ~50 chars margin)
          if (testChunk.length > 970) {
            if (currentChunk) {
              chunks.push(currentChunk);
              currentChunk = domainText;
            } else {
              // Single domain too long (shouldn't happen but handle it)
              chunks.push(domainText);
            }
          } else {
            currentChunk = testChunk;
          }
        }
        
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        
        return chunks;
      }
      
      // Process static domains
      if (staticDomains.length > 0) {
        console.log(`📋 Processing static domains into chunks (${staticDomains.length} domains)`);
        const staticChunks = createDomainChunks(staticDomains, "📋 Static Domains");
        
        staticChunks.forEach((chunk, index) => {
          const embed = createEmbed('update', index === 0 ? 'Monitored Domains - Static' : `Static Domains (continued ${index + 1})`);
          embed.fields = [{
            name: `📋 Static Domains${staticChunks.length > 1 ? ` (${index + 1}/${staticChunks.length})` : ''} (${staticDomains.length} total)`,
            value: chunk,
            inline: false
          }];
          embeds.push(embed);
        });
      }
      
      // Process dynamic domains  
      if (dynamicDomains.length > 0) {
        console.log(`📋 Processing dynamic domains into chunks (${dynamicDomains.length} domains)`);
        const dynamicChunks = createDomainChunks(dynamicDomains, "🔧 Dynamic Domains");
        
        dynamicChunks.forEach((chunk, index) => {
          const embed = createEmbed('update', 
            staticDomains.length === 0 && index === 0 ? 'Monitored Domains - Dynamic' : 
            index === 0 ? 'Monitored Domains - Dynamic' : 
            `Dynamic Domains (continued ${index + 1})`
          );
          embed.fields = [{
            name: `🔧 Dynamic Domains${dynamicChunks.length > 1 ? ` (${index + 1}/${dynamicChunks.length})` : ''} (${dynamicDomains.length} total)`,
            value: chunk,
            inline: false
          }];
          embeds.push(embed);
        });
      }
      
      // Add summary embed
      console.log("📋 Adding summary embed...");
      const summaryEmbed = createEmbed('update', 'Domain Summary');
      summaryEmbed.fields = [{
        name: "📊 Total Overview",
        value: `**Total Monitored:** ${staticDomains.length + dynamicDomains.length} domains\n**Static Domains:** ${staticDomains.length} (config-based)\n**Dynamic Domains:** ${dynamicDomains.length} (bot-managed)\n**Embeds Used:** ${embeds.length + 1}`,
        inline: false
      }];
      embeds.push(summaryEmbed);
    }

    console.log(`📤 Sending ${embeds.length} embeds as followup message...`);
    console.log(`📤 Followup URL: ${followupUrl}`);
    
    // Send results as followup - Discord supports up to 10 embeds per message
    const response = await fetch(followupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: embeds
      })
    });
    
    console.log(`📤 Followup response status: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`📤 Followup failed: ${response.status} - ${errorText}`);
      throw new Error(`Discord API error: ${response.status} - ${errorText}`);
    }
    
    console.log("✅ performListDomainsAsync completed successfully");
    
  } catch (error) {
    console.error("❌ Error in performListDomainsAsync:", error);
    
    // Send error as followup
    try {
      console.log("📤 Sending error followup...");
      const errorResponse = await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `❌ Failed to list domains: ${error instanceof Error ? error.message : String(error)}`
        })
      });
      
      console.log(`📤 Error followup response status: ${errorResponse.status}`);
      if (!errorResponse.ok) {
        const errorText = await errorResponse.text();
        console.error(`📤 Error followup failed: ${errorResponse.status} - ${errorText}`);
      } else {
        console.log("✅ Error followup sent successfully");
      }
    } catch (followupError) {
      console.error("❌ Failed to send followup error:", followupError);
    }
  }
}

async function handleListDomains(interaction: DiscordInteraction, env: Env, ctx?: ExecutionContext): Promise<DiscordInteractionResponse> {
  if (ctx) {
    // Use proper execution context to ensure async work completes
    ctx.waitUntil(performListDomainsAsync(interaction, env));
  } else {
    // Fallback: start async work immediately  
    performListDomainsAsync(interaction, env).catch(error => {
      console.error("Background list domains failed:", error);
    });
  }
  
  // Return deferred response IMMEDIATELY
  return {
    type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: {}
  };
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

async function performSubdomainDiscoveryAsync(interaction: DiscordInteraction, env: Env, domain: string, verifyAll: boolean): Promise<void> {
  const followupUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  
  try {
    // First check if root domain is already being monitored
    const domains = await getDynamicDomains(env);
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
    const allCurrentDomains = [...staticDomains, ...domains];
    
    const rootAlreadyExists = allCurrentDomains.includes(domain);

    // Discover subdomains with timeout for responsiveness
    let discovery;
    try {
      console.log(`🔍 Starting quick subdomain discovery for ${domain}...`);
      discovery = await Promise.race([
        discoverSubdomains(domain, env, verifyAll),
        new Promise<{
          existing: string[];
          added: string[];
          skipped: string[];
          errors: string[];
        }>((_, reject) => 
          setTimeout(() => reject(new Error('Discovery timeout after 8 seconds')), 8000)
        )
      ]);
    } catch (discoveryError) {
      console.error('Subdomain discovery failed:', discoveryError);
      // Fallback: just add the root domain
      discovery = {
        existing: rootAlreadyExists ? [domain] : [],
        added: rootAlreadyExists ? [] : [domain],
        skipped: [],
        errors: [`Discovery failed: ${discoveryError instanceof Error ? discoveryError.message : String(discoveryError)}`]
      };
    }
    
    // Add root domain if not already monitored
    if (!rootAlreadyExists) {
      domains.push(domain);
      discovery.added.unshift(domain); // Add to beginning of list
    }
    
    // Add discovered subdomains
    for (const subdomain of discovery.added.filter(d => d !== domain)) {
      if (!domains.includes(subdomain)) {
        domains.push(subdomain);
      }
    }
    
    // Save updated domains
    await saveDynamicDomains(env, domains);

    // Update bot status
    const totalDomains = staticDomains.length + domains.length;
    await updateBotStatus(env, totalDomains, new Date().toISOString());

    // Create response embed
    const embed = createEmbed('update', 'Domain Discovery Complete');
    embed.description = `Completed subdomain discovery for \`${domain}\``;
    
    const fields = [];
    
    if (discovery.added.length > 0) {
      const addedText = discovery.added.length > 10 
        ? `${discovery.added.slice(0, 5).map(d => `\`${d}\``).join(", ")} and ${discovery.added.length - 5} more...`
        : discovery.added.map(d => `\`${d}\``).join(", ");
      
      fields.push({
        name: `✅ Added (${discovery.added.length})`,
        value: addedText,
        inline: false
      });
    }
    
    if (discovery.existing.length > 0) {
      const existingText = discovery.existing.length > 10 
        ? `${discovery.existing.slice(0, 5).map(d => `\`${d}\``).join(", ")} and ${discovery.existing.length - 5} more...`
        : discovery.existing.map(d => `\`${d}\``).join(", ");
      
      fields.push({
        name: `📋 Already Monitored (${discovery.existing.length})`,
        value: existingText,
        inline: false
      });
    }
    
    if (discovery.skipped.length > 0 && discovery.skipped.length <= 5) {
      fields.push({
        name: `⏭️ Not Found (${discovery.skipped.length})`,
        value: discovery.skipped.slice(0, 5).map(d => `\`${d}\``).join(", "),
        inline: false
      });
    } else if (discovery.skipped.length > 5) {
      fields.push({
        name: `⏭️ Not Found (${discovery.skipped.length})`,
        value: `${discovery.skipped.slice(0, 3).map(d => `\`${d}\``).join(", ")} and ${discovery.skipped.length - 3} more...`,
        inline: false
      });
    }
    
    if (discovery.errors.length > 0) {
      const errorText = discovery.errors.length > 3 
        ? `${discovery.errors.slice(0, 2).join(", ")} and ${discovery.errors.length - 2} more...`
        : discovery.errors.join(", ");
      
      fields.push({
        name: `❌ Errors (${discovery.errors.length})`,
        value: errorText,
        inline: false
      });
    }
    
    fields.push({
      name: "📊 Summary",
      value: `**Total Domains:** ${totalDomains}\n**Added by:** ${interaction.member?.user?.username || interaction.user?.username || "Unknown"}\n**Verification:** ${verifyAll ? "All domains verified" : "Standard discovery"}`,
      inline: false
    });
    
    if (discovery.added.length > 0) {
      fields.push({
        name: "ℹ️ Note",
        value: "Initial DNS state will be recorded for new domains without triggering alerts",
        inline: false
      });
    }
    
    embed.fields = fields;

    // Send results as followup
    await fetch(followupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });
    
  } catch (error) {
    console.error("Error in async subdomain discovery:", error);
    
    // Send error as followup
    try {
      await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `❌ Failed to discover subdomains: ${error instanceof Error ? error.message : String(error)}`
        })
      });
    } catch (followupError) {
      console.error("Failed to send followup error:", followupError);
    }
  }
}

async function handleAddWithSubdomains(interaction: DiscordInteraction, env: Env, ctx?: ExecutionContext): Promise<DiscordInteractionResponse> {
  const domain = interaction.data?.options?.find(opt => opt.name === "domain")?.value?.toLowerCase();
  const verifyAllOption = interaction.data?.options?.find(opt => opt.name === "verify-all")?.value;
  const verifyAll = Boolean(verifyAllOption);
  
  if (!domain) {
    return {
      type: 4,
      data: {
        content: "❌ Please provide a domain name.",
        flags: 64
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

  if (ctx) {
    // Use proper execution context to ensure async work completes
    ctx.waitUntil(performSubdomainDiscoveryAsync(interaction, env, domain, verifyAll));
  } else {
    // Fallback: start async work immediately
    performSubdomainDiscoveryAsync(interaction, env, domain, verifyAll).catch(error => {
      console.error("Background subdomain discovery failed:", error);
    });
  }

  // Return deferred response IMMEDIATELY
  return {
    type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: {}
  };
}

async function handleDampening(interaction: DiscordInteraction, env: Env): Promise<DiscordInteractionResponse> {
  const domain = interaction.data?.options?.find(opt => opt.name === "domain")?.value?.toLowerCase();
  const clear = interaction.data?.options?.find(opt => opt.name === "clear")?.value || false;
  
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
    const now = Date.now();
    const lastNotificationKey = `notify:${domain}:last`;
    const recentIPsKey = `notify:${domain}:recent_ips`;
    
    // Get current dampening data
    const lastNotificationTime = await env.DNS_KV.get(lastNotificationKey);
    const lastNotifyTime = lastNotificationTime ? parseInt(lastNotificationTime) : 0;
    const recentIPsData = await env.DNS_KV.get(recentIPsKey);
    const recentIPSets: Array<{ips: string[], timestamp: number}> = recentIPsData ? JSON.parse(recentIPsData) : [];
    
    // Clear dampening if requested
    if (clear) {
      await env.DNS_KV.delete(lastNotificationKey);
      await env.DNS_KV.delete(recentIPsKey);
      
      const embed = createEmbed('update', 'Dampening Cleared');
      embed.description = `Cleared DNS change notification dampening for \`${domain}\``;
      embed.fields = [
        {
          name: "Result",
          value: "Next DNS change will trigger immediate notification",
          inline: false
        },
        {
          name: "Cleared By",
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
    }
    
    // Enhanced dampening status with intelligent analysis
    const embed = createEmbed('update', 'Enhanced DNS Dampening Status');
    embed.description = `Intelligent dampening analysis for \`${domain}\``;
    
    const fields = [];
    
    if (lastNotifyTime > 0) {
      const timeSinceLastNotify = now - lastNotifyTime;
      const minutesAgo = Math.round(timeSinceLastNotify / (60 * 1000));
      
      fields.push({
        name: "Last Notification",
        value: `${minutesAgo} minutes ago`,
        inline: true
      });
    } else {
      fields.push({
        name: "Last Notification",
        value: "Never",
        inline: true
      });
    }
    
    if (recentIPSets.length > 0) {
      // Enhanced pattern analysis
      const cdnInfo = IntelligentCDNDetector.detectProvider(recentIPSets[recentIPSets.length - 1]?.ips || []);
      const lbInfo = LoadBalancerIntelligence.analyzePattern(recentIPSets);
      const timeInfo = TemporalAnalyzer.analyzeTimePatterns(recentIPSets);
      
      fields.push({
        name: "Recent Activity",
        value: `${recentIPSets.length} IP sets tracked`,
        inline: true
      });
      
      // Show recent IP changes
      const recentChanges = recentIPSets
        .slice(-3)
        .map(set => {
          const minutesAgo = Math.round((now - set.timestamp) / (60 * 1000));
          return `${set.ips.join(", ")} (${minutesAgo}m ago)`;
        })
        .join("\n");
        
      fields.push({
        name: "Recent IP Changes",
        value: recentChanges || "None",
        inline: false
      });
      
      // Enhanced pattern detection results
      if (cdnInfo.isAnyCDN) {
        fields.push({
          name: "🌐 CDN Detection",
          value: cdnInfo.provider ? 
            `${cdnInfo.provider} (${Math.round(cdnInfo.confidence * 100)}% confidence)` :
            `Generic CDN (${Math.round(cdnInfo.confidence * 100)}% confidence)`,
          inline: true
        });
      }
      
      if (lbInfo.isLoadBalancer) {
        fields.push({
          name: "⚖️ Load Balancer Pattern",
          value: `${lbInfo.pattern} (${Math.round(lbInfo.confidence * 100)}% confidence)\n${lbInfo.analysis}`,
          inline: false
        });
      }
      
      fields.push({
        name: "⏰ Time Analysis",
        value: `Pattern: ${timeInfo.timePattern.replace('_', ' ')}\nMaintenance Window: ${timeInfo.isMaintenanceWindow ? 'Yes' : 'No'}\nBusiness Hours: ${timeInfo.isBusinessHours ? 'Yes' : 'No'}`,
        inline: true
      });
      
      // Check for oscillation with enhanced detection
      if (recentIPSets.length > 1) {
        const uniqueIPSets = new Set(recentIPSets.map(set => set.ips.sort().join(',')));
        if (uniqueIPSets.size < recentIPSets.length) {
          fields.push({
            name: "🔄 Oscillation Analysis",
            value: `Switching between ${uniqueIPSets.size} IP sets\nPattern: ${lbInfo.isLoadBalancer ? lbInfo.pattern : 'Unknown'}\nFrequency: ${recentIPSets.length} changes tracked`,
            inline: false
          });
        }
      }
      
    } else {
      fields.push({
        name: "Recent Activity",
        value: "No recent changes tracked",
        inline: true
      });
    }
    
    fields.push({
      name: "💡 Actions",
      value: "• Use `/dampening domain clear:true` to reset dampening\n• Check `/status domain` for current DNS state\n• Review patterns above for optimization opportunities",
      inline: false
    });
    
    embed.fields = fields;
    
    return {
      type: 4,
      data: {
        embeds: [embed]
      }
    };
    
  } catch (error) {
    console.error("Error checking dampening status:", error);
    return {
      type: 4,
      data: {
        content: `❌ Failed to check dampening status: ${error instanceof Error ? error.message : String(error)}`,
        flags: 64
      }
    };
  }
}

async function handleDiscoverThorough(interaction: DiscordInteraction, env: Env, ctx?: ExecutionContext): Promise<DiscordInteractionResponse> {
  const domain = interaction.data?.options?.find(opt => opt.name === "domain")?.value?.toLowerCase();
  
  if (!domain) {
    return {
      type: 4,
      data: {
        content: "❌ Please provide a domain name.",
        flags: 64
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

  if (ctx) {
    // Use proper execution context to ensure async work completes
    ctx.waitUntil(performDiscoverThoroughAsync(interaction, env, domain));
  } else {
    // Fallback: start async work immediately
    performDiscoverThoroughAsync(interaction, env, domain).catch(error => {
      console.error("Background thorough discovery failed:", error);
    });
  }

  // Return deferred response IMMEDIATELY
  return {
    type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    data: {}
  };
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
      value: "Add a single domain to monitoring\nExample: `/add example.com`",
      inline: false
    },
    {
      name: "🔍 `/add-with-subdomains <domain>`",
      value: "Fast subdomain discovery using Certificate Transparency logs\nExample: `/add-with-subdomains example.com`\nOption: `verify-all` to verify all discovered domains are active\n⏱️ Takes 3-5 seconds (optimized for speed)",
      inline: false
    },
    {
      name: "🕵️ `/discover <domain>`",
      value: "Thorough subdomain discovery using multiple methods with full verification\nExample: `/discover example.com`\nUses CT logs + DNS enumeration + wordlist with complete validation",
      inline: false
    },
    {
      name: "➖ `/remove <domain>`",
      value: "Remove a domain from monitoring\nExample: `/remove example.com`",
      inline: false
    },
    {
      name: "🗑️ `/remove-with-subdomains <domain>`",
      value: "Remove a domain and ALL its subdomains from monitoring\nExample: `/remove-with-subdomains example.com`\nRemoves example.com, www.example.com, api.example.com, etc.",
      inline: false
    },
    {
      name: "📊 `/status <domain>`",
      value: "Check current DNS status of a domain\nExample: `/status example.com`",
      inline: false
    },
    {
      name: "🔇 `/dampening <domain>`",
      value: "Check or clear DNS change notification dampening\nExample: `/dampening app.example.com`\nClear: `/dampening app.example.com clear:true`",
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

async function handleDiscordInteraction(interaction: DiscordInteraction, env: Env, ctx?: ExecutionContext): Promise<DiscordInteractionResponse> {
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
      case "add-with-subdomains":
        return await handleAddWithSubdomains(interaction, env, ctx);
      case "discover":
        return await handleDiscoverThorough(interaction, env, ctx);
      case "remove":
        return await handleRemoveDomain(interaction, env);
      case "remove-with-subdomains":
        return await handleRemoveWithSubdomains(interaction, env, ctx);
      case "list":
        return await handleListDomains(interaction, env, ctx);
      case "status":
        return await handleDomainStatus(interaction, env);
      case "dampening":
        return await handleDampening(interaction, env);
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
        
        const response = await handleDiscordInteraction(interaction, env, ctx);
        
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

async function performDiscoverThoroughAsync(interaction: DiscordInteraction, env: Env, domain: string): Promise<void> {
  const followupUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  
  try {
    // Check if root domain is already being monitored
    const domains = await getDynamicDomains(env);
    const staticDomains = env.MONITOR_DOMAINS ? env.MONITOR_DOMAINS.split(",").map(d => d.trim()) : [];
    const allCurrentDomains = [...staticDomains, ...domains];
    
    const rootAlreadyExists = allCurrentDomains.includes(domain);

    // Thorough discovery with verification (verifyAll = true)
    console.log(`🔍 Starting thorough subdomain discovery for ${domain}...`);
    const discovery = await discoverSubdomains(domain, env, true);
    
    // Add root domain if not already monitored
    if (!rootAlreadyExists) {
      domains.push(domain);
      if (!discovery.added.includes(domain)) {
        discovery.added.unshift(domain);
      }
    }
    
    // Add discovered subdomains
    for (const subdomain of discovery.added.filter(d => d !== domain)) {
      if (!domains.includes(subdomain)) {
        domains.push(subdomain);
      }
    }
    
    // Save to KV
    if (discovery.added.length > 0) {
      await env.DNS_KV.put("dynamic:domains", JSON.stringify(domains));
    }

    // Build response
    const embed = createEmbed('update', 'Thorough Subdomain Discovery Complete');
    embed.description = `Completed comprehensive discovery for \`${domain}\` using multiple methods and verification`;
    
    const fields = [];
    
    if (discovery.added.length > 0) {
      const addedText = discovery.added.length > 15 
        ? `${discovery.added.slice(0, 10).map(d => `\`${d}\``).join(", ")} and ${discovery.added.length - 10} more...`
        : discovery.added.map(d => `\`${d}\``).join(", ");
      
      fields.push({
        name: `✅ Added (${discovery.added.length})`,
        value: addedText,
        inline: false
      });
    }
    
    if (discovery.existing.length > 0) {
      const existingText = discovery.existing.length > 10 
        ? `${discovery.existing.slice(0, 5).map(d => `\`${d}\``).join(", ")} and ${discovery.existing.length - 5} more...`
        : discovery.existing.map(d => `\`${d}\``).join(", ");
      
      fields.push({
        name: `📋 Already Monitored (${discovery.existing.length})`,
        value: existingText,
        inline: false
      });
    }
    
    if (discovery.skipped.length > 0) {
      fields.push({
        name: `⏭️ Verified Inactive (${discovery.skipped.length})`,
        value: discovery.skipped.length > 5 
          ? `${discovery.skipped.slice(0, 3).map(d => `\`${d}\``).join(", ")} and ${discovery.skipped.length - 3} more...`
          : discovery.skipped.slice(0, 5).map(d => `\`${d}\``).join(", "),
        inline: false
      });
    }
    
    if (discovery.errors.length > 0) {
      fields.push({
        name: `❌ Errors (${discovery.errors.length})`,
        value: `${discovery.errors.length} domains had verification errors`,
        inline: false
      });
    }
    
    fields.push({
      name: "📊 Discovery Summary",
      value: `**Method:** Multi-source CT + DNS enumeration + wordlist\n**Verification:** All domains verified\n**Total Monitored:** ${domains.length}\n**By:** ${interaction.member?.user?.username || interaction.user?.username || "Unknown"}`,
      inline: false
    });
    
    if (discovery.added.length > 0) {
      fields.push({
        name: "ℹ️ Note",
        value: "Initial DNS state will be recorded for new domains without triggering alerts",
        inline: false
      });
    }
    
    embed.fields = fields;

    // Send followup response
    await fetch(followupUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed]
      })
    });
    
  } catch (error) {
    console.error('Error in performDiscoverThoroughAsync:', error);
    
    // Send error as followup
    try {
      await fetch(followupUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: `❌ Error during thorough discovery: ${error instanceof Error ? error.message : String(error)}`
        })
      });
    } catch (followupError) {
      console.error("Failed to send followup error:", followupError);
    }
  }
}

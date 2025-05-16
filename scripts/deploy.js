const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper to run commands and handle errors
function runCommand(command, errorMessage) {
  try {
    return execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error(`❌ ${errorMessage}`);
    console.error(error.message);
    process.exit(1);
  }
}

// Helper to prompt for input
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Check if Wrangler is installed
function checkWrangler() {
  try {
    execSync("npx wrangler --version", { stdio: "ignore" });
    console.log("✅ Wrangler is installed");
  } catch (error) {
    console.error("❌ Installing Wrangler...");
    runCommand(
      "npm install --save-dev wrangler@4",
      "Failed to install Wrangler"
    );
  }
}

// Check if logged in to Cloudflare
function checkCloudflareLogin() {
  try {
    execSync("npx wrangler whoami", { stdio: "ignore" });
    console.log("✅ Logged in to Cloudflare");
  } catch (error) {
    console.error("❌ Not logged in to Cloudflare. Please login...");
    runCommand("npx wrangler login", "Failed to login to Cloudflare");
  }
}

// Update wrangler.toml with config values
function updateWranglerConfig() {
  console.log("📝 Updating wrangler.toml with config values...");

  // Read config.json
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf8")
  );

  // Read wrangler.toml
  const wranglerPath = path.join(__dirname, "../wrangler.toml");
  let wranglerContent = fs.readFileSync(wranglerPath, "utf8");

  // Update KV namespace ID
  wranglerContent = wranglerContent.replace(
    /id = ".*"/,
    `id = "${config.kvNamespace.id}"`
  );

  // Update cron schedule
  wranglerContent = wranglerContent.replace(
    /crons = \[".*"\]/,
    `crons = ["${config.cron}"]`
  );

  // Write updated wrangler.toml
  fs.writeFileSync(wranglerPath, wranglerContent);
  console.log("✅ Updated wrangler.toml with config values");
}

// Setup KV namespace
async function setupKVNamespace() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf8")
  );

  if (!config.kvNamespace?.id) {
    console.log("Creating KV namespace...");
    const output = execSync('npx wrangler kv:namespace create "DNS_KV"', {
      encoding: "utf8",
    });
    const match = output.match(/id = "([^"]+)"/);

    if (!match) {
      console.error("❌ Failed to create KV namespace");
      process.exit(1);
    }

    const namespaceId = match[1];
    config.kvNamespace = { id: namespaceId };
    fs.writeFileSync(
      path.join(__dirname, "../config.json"),
      JSON.stringify(config, null, 2)
    );
    console.log("✅ KV namespace created and added to config.json");
  } else {
    console.log("✅ KV namespace already configured");
  }
}

// Check and set up Discord webhook
async function setupDiscordWebhook() {
  let webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    console.log("ℹ️ Using DISCORD_WEBHOOK_URL from environment");
    try {
      execSync(`echo '${webhookUrl}' | npx wrangler secret put DISCORD_WEBHOOK_URL`, {
        stdio: "inherit"
      });
      console.log("✅ Discord webhook URL set from environment");
    } catch (error) {
      console.error("❌ Failed to set Discord webhook URL from environment:", error.message);
      process.exit(1);
    }
  } else {
    try {
      execSync("npx wrangler secret get DISCORD_WEBHOOK_URL", {
        stdio: "ignore",
      });
      console.log("✅ Discord webhook URL is already set");
    } catch (error) {
      const webhook = await prompt("Enter your Discord webhook URL: ");
      try {
        execSync(`echo '${webhook}' | npx wrangler secret put DISCORD_WEBHOOK_URL`, {
          stdio: "inherit"
        });
        console.log("✅ Discord webhook URL set successfully");
      } catch (error) {
        console.error("❌ Failed to set Discord webhook URL:", error.message);
        process.exit(1);
      }
    }
  }
}

// Check and set up Discord role tag
async function setupDiscordRoleTag() {
  let roleTag = process.env.DISCORD_ROLE_ID;
  if (roleTag) {
    console.log("ℹ️ Using DISCORD_ROLE_ID from environment");
    try {
      execSync(`echo '${roleTag}' | npx wrangler secret put DISCORD_ROLE_ID`, {
        stdio: "inherit"
      });
      console.log("✅ Discord role tag set from environment");
    } catch (error) {
      console.error("❌ Failed to set Discord role tag from environment:", error.message);
      process.exit(1);
    }
  } else {
    try {
      execSync("npx wrangler secret get DISCORD_ROLE_ID", {
        stdio: "ignore",
      });
      console.log("✅ Discord role tag is already set");
    } catch (error) {
      const roleTag = await prompt("Enter your Discord role ID to mention (without @ symbol): ");
      try {
        execSync(`echo '${roleTag}' | npx wrangler secret put DISCORD_ROLE_ID`, {
          stdio: "inherit"
        });
        console.log("✅ Discord role tag set successfully");
      } catch (error) {
        console.error("❌ Failed to set Discord role tag:", error.message);
        process.exit(1);
      }
    }
  }
}

// Set up MONITOR_DOMAINS from config.json
async function setupMonitorDomains() {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf8")
  );
  const domains = config.domains.join(",");

  console.log("ℹ️ Setting MONITOR_DOMAINS from config.json");
  try {
    execSync(`echo '${domains}' | npx wrangler secret put MONITOR_DOMAINS`, {
      stdio: "inherit"
    });
    console.log("✅ MONITOR_DOMAINS set successfully");
  } catch (error) {
    console.error("❌ Failed to set MONITOR_DOMAINS:", error.message);
    process.exit(1);
  }
}

// Main deployment process
async function deploy() {
  console.log("🚀 Starting deployment process...\n");

  // Check prerequisites
  checkWrangler();
  checkCloudflareLogin();

  // Set up configuration
  await setupKVNamespace();
  await setupDiscordWebhook();
  await setupDiscordRoleTag();
  await setupMonitorDomains();
  updateWranglerConfig();

  // Deploy the worker
  console.log("\n📦 Deploying worker...");
  try {
    const deployOutput = execSync("npx wrangler deploy", { encoding: "utf8" });
    console.log("✅ Worker deployed successfully");
    
    // Extract and display the version ID
    const versionMatch = deployOutput.match(/Version ID: ([a-f0-9-]+)/i);
    if (versionMatch && versionMatch[1]) {
      const versionId = versionMatch[1];
      console.log(`📝 Deployment Version ID: ${versionId}`);
      
      // Save version to file
      fs.writeFileSync(path.join(__dirname, "../.version"), versionId);
      
      // Skip direct KV updates since wrangler command format has changed
      // Instead, set as a secret/environment variable
      try {
        execSync(`echo '${versionId}' | npx wrangler secret put WORKER_VERSION_ID`, {
          stdio: "inherit"
        });
        console.log("✅ Version ID set as environment variable");
        
        // The worker will store the version in KV when it runs
        console.log("👉 Note: Version ID will be stored in KV during worker's first execution");
      } catch (error) {
        console.error("⚠️ Failed to set Version ID as environment variable:", error.message);
        // Non-fatal error, continue with deployment
      }
    } else {
      console.log("⚠️ Could not extract Version ID from deployment output");
    }
  } catch (error) {
    console.error("❌ Deployment failed:", error.message);
    process.exit(1);
  }
  
  console.log("\n✅ Deployment completed successfully!");
  rl.close();
}

// Run deployment
deploy().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exit(1);
});

import { installDiscordConversations } from "../adapters/discord/turn.js";
import { config } from "dotenv";
config();

import { SessionManager } from "../sessionManager.js";
import { createBot } from "../bot.js";
import { contributionReviewsEnabled } from "../common/githubContributionReviewWorker.js";
import { githubContributionService } from "../common/githubContributions.js";
import { discordSubject } from "../common/discordAccess.js";
import { DiscordRuntime } from "./discordLifecycle.js";
import { githubContributionsEnabled } from "../common/githubContributionConfig.js";
import { githubContributionLimits } from "../common/githubContributionLimits.js";

if (githubContributionsEnabled()) githubContributionLimits();

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("❌ DISCORD_TOKEN is not set in .env");
  process.exit(1);
}

let reviewsStarted = false;
const runtime = new DiscordRuntime({
  createSessions: () => new SessionManager(),
  installConversations: installDiscordConversations,
  createClient: createBot,
  startReviews: client => {
    if (contributionReviewsEnabled()) {
      reviewsStarted = true;
      githubContributionService().startReviews((user, guild) => discordSubject(client, user, guild));
    }
  },
  stopReviews: async () => { if (reviewsStarted) await githubContributionService().stopReviews(); },
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received — shutting down...`);
  try {
    await runtime.stop();
    console.log("✅ Shutdown complete.");
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
}

const onInterrupt = () => { void shutdown("SIGINT"); };
const onTerminate = () => { void shutdown("SIGTERM"); };
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
try {
  await runtime.start(token);
} catch (error) {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  throw error;
}

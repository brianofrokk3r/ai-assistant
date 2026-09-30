import { config } from "dotenv";
config();
import { reportProviderSecurityConfiguration } from "./common/providerSecurity.js";
reportProviderSecurityConfiguration();
const adapter = process.env.AI_ASSISTANT_ADAPTER?.trim() || 'discord';
if (adapter === 'discord')
    await import('./composition/discord.js');
else if (adapter === 'slack') {
    const { startSlack } = await import('./adapters/slack.js');
    const controller = new AbortController();
    let slack;
    const stop = () => {
        controller.abort();
        void slack?.stop().catch(error => { console.error(error); process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        slack = await startSlack(controller.signal);
    }
    catch (error) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (error !== controller.signal.reason)
            throw error;
    }
}
else
    throw new Error('AI_ASSISTANT_ADAPTER must be discord or slack. Use ai-assistant cli for local conversations.');

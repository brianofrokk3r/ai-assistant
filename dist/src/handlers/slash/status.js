import { interactionSessionKey } from "../../common/discordSessionKey.js";
export async function handleStatus(interaction, sessions) {
    try {
        await interaction.deferReply({ ephemeral: true });
        const sessionKey = interactionSessionKey(interaction);
        const { status, authStatus, providerSecurity } = await sessions.getStatus(sessionKey);
        const authLine = authStatus.isAuthenticated
            ? `✅ Authenticated as **${authStatus.login ?? "unknown"}** via \`${authStatus.authType}\` on \`${authStatus.host ?? "github.com"}\``
            : `❌ Not authenticated — ${authStatus.statusMessage ?? "unknown reason"}`;
        const securityLines = providerSecurity
            ? `\nHosted web search: \`${providerSecurity.hostedWebSearch ?? "provider default"}\`\nSandboxed-command network: \`${providerSecurity.sandboxedCommandNetwork ?? "provider default"}\``
            : "";
        await interaction.editReply(`**${sessions.activeProviderDisplayName(sessionKey)} Status**\n${authLine}\nCLI version: \`${status.version}\`\nProvider: \`${sessions.activeProviderName(sessionKey)}\`${securityLines}`);
    }
    catch (err) {
        console.error("[/status] Error:", err);
        const msg = "❌ Failed to retrieve status. Please try again.";
        if (interaction.deferred) {
            await interaction.editReply(msg);
        }
        else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
}

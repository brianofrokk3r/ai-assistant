import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../common/sessionStore.js';
export async function createTextEngine(name, directory) {
    if (name !== 'fake') {
        const { defaultProviderWorkingDirectory, workspacePathIsAllowed, configuredSecurityMode } = await import('../common/providerSecurity.js');
        if (configuredSecurityMode() === 'shared' && workspacePathIsAllowed(defaultProviderWorkingDirectory(), directory))
            throw new Error('Adapter state must be outside provider-readable workspace paths.');
        const { SessionManager } = await import('../sessionManager.js');
        const stores = join(directory, 'providers');
        const manager = new SessionManager(name, undefined, stores);
        return {
            contextIdentity(key) {
                const provider = manager.activeProviderName(key);
                return JSON.stringify([provider, new SessionStore(provider, join(stores, 'sessions-' + provider + '.json')).get(key) ?? null]);
            },
            sendMessage: (key, prompt, attachments, options) => manager.sendMessage(key, prompt, attachments, options),
            resetSession: key => manager.resetSession(key),
            async configureSession(key, provider, model, reasoning) {
                await manager.setSessionProvider(key, provider);
                await manager.setModel(key, model);
                if (reasoning)
                    await manager.setReasoningEffort(key, reasoning);
            },
            forgetSession: key => manager.forgetSession(key),
            shutdown: () => manager.shutdown(),
        };
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = (key) => join(directory, createHash('sha256').update(key).digest('hex') + '.json');
    return {
        contextIdentity(key) {
            try {
                return JSON.stringify(['fake', JSON.parse(readFileSync(file(key), 'utf8')).generation ?? null]);
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
                return JSON.stringify(['fake', null]);
            }
        },
        async sendMessage(key, prompt) {
            let count = 0;
            let generation = randomUUID();
            try {
                const saved = JSON.parse(readFileSync(file(key), 'utf8'));
                count = saved.count;
                generation = saved.generation ?? generation;
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            const output = { content: `Fake response (turn ${count + 1}): ${prompt}`, attachments: [] };
            writeFileSync(file(key) + '.tmp', JSON.stringify({ count: count + 1, generation }), { mode: 0o600 });
            renameSync(file(key) + '.tmp', file(key));
            return output;
        },
        async resetSession(key) { try {
            unlinkSync(file(key));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        } },
        async configureSession() { },
        async forgetSession(key) { try {
            unlinkSync(file(key));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        } },
        async shutdown() { },
    };
}

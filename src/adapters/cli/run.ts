import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ConversationService } from '../../application/conversationService.js';
import { FileTurnJournal } from '../../application/conversationService.js';
import { sessionKey, TEXT_CAPABILITIES, type IncomingTurn } from '../../core/conversation.js';
import { createTextEngine } from '../../composition/textEngine.js';
export async function runCli(args = process.argv.slice(3), makeEngine = createTextEngine): Promise<void> {
  const opts: Record<string,string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '--reset') { opts[arg.slice(2)] = 'true'; continue; }
    if (!['--channel','--thread','--message','--provider'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --channel, --thread, --message, --provider, --json or --reset.');
    opts[arg.slice(2)] = args[++i];
  }
  if (opts.json && !opts.message && !opts.reset) throw new Error('--json requires --message or --reset.');
  const originalLog = console.log;
  if (opts.json) console.log = (...values) => console.error(...values);
  const directory = process.env.AI_ASSISTANT_STATE_DIR ?? join(homedir(), '.config', 'ai-assistant', 'adapters');
  let journal: FileTurnJournal | undefined;
  let service: ConversationService | undefined;
  let engine: Awaited<ReturnType<typeof createTextEngine>> | undefined;
  let cancel: (() => void) | undefined;
  let interrupted = false;
  let terminal: ReturnType<typeof createInterface> | undefined;
  let signalExitCode = 130;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    signalExitCode = signal === 'SIGTERM' ? 143 : 130;
    process.exitCode = signalExitCode;
    terminal?.close();
    cancel?.();
    console.error('Cancellation requested; waiting for the active provider to stop.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    journal = new FileTurnJournal(join(directory, 'cli-turns'));
    const conversations = service = new ConversationService(journal);
    // Let signals queued during synchronous journal restoration run before startup.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (interrupted) return;
    const actor = { platform: 'cli', tenantId: 'local', userId: process.env.AI_ASSISTANT_CLI_USER || userInfo().username };
    const input = (text: string): IncomingTurn => ({ eventId: randomUUID(), text, actor, receivedAt: new Date().toISOString(),
      conversation: { platform: 'cli', tenantId: 'local', installationId: 'local', channelId: opts.channel || 'local', threadId: opts.thread || 'default', kind: 'thread' } });
    const print = (data: unknown) => process.stdout.write((opts.json ? JSON.stringify(data) : String(data)) + '\n');
    engine = await makeEngine(opts.provider || process.env.PROVIDER || 'copilot', join(directory, 'cli-provider-state'));
    if (interrupted) return;
    const reset = async () => {
      if (process.env.AI_ASSISTANT_CLI_ALLOW_RESET === 'false') throw new Error('Reset is disabled by local policy.');
      await conversations.serial(sessionKey(input(''), 'individual'), () => engine!.resetSession(sessionKey(input(''), 'individual')));
      print(opts.json ? { status: 'reset' } : 'Session reset.');
    };
    const turn = async (text: string) => {
      const handle = await conversations.submit(input(text), {
        platform: 'cli', tenantId: 'local', installationId: 'local', capabilities: TEXT_CAPABILITIES, audience: 'individual',
        authorize: async i => i.actor.userId === actor.userId,
        prepare: async i => ({ prompt: i.text }),
        generate: (p, key, signal, onProgress) => engine!.sendMessage(key, p.prompt, undefined, { transportContext: { platform: 'cli', history: false, attachments: false }, signal, onProgress }),
        progress: async p => { console.error(p.message); },
        deliver: async output => { print(opts.json ? { status: 'delivered', content: output.content, unsupportedAttachments: output.attachments.length } : output.content + (output.attachments.length ? '\n[File delivery unavailable in CLI.]' : '')); return { messageIds: [] }; },
      });
      cancel = handle.cancel;
      if (interrupted) handle.cancel();
      const result = await handle.completion;
      cancel = undefined;
      if (result.state !== 'delivered') { print(opts.json ? { status: result.state, error: result.error } : result.error); process.exitCode = interrupted ? signalExitCode : 1; }
    };
    if (opts.reset) await reset();
    if (opts.message) await turn(opts.message);
    else if (!opts.reset) {
      terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      console.error('Enter a message, /reset or /quit.');
      try { for await (const line of terminal) { if (line === '/quit' || interrupted) break; if (line === '/reset') await reset(); else if (line.trim()) await turn(line); } }
      finally { terminal.close(); }
    }
  } finally {
    try { if (service) await service.shutdown(); else journal?.close(); }
    finally {
      try { await engine?.shutdown(); }
      finally {
        terminal?.close();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        console.log = originalLog;
      }
    }
  }
}

// @test-ci {"native":true}
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import {
  type ACPClientConnectionDelegate,
  ACPNativeProcess,
  type ACPSessionNotification,
  type ACPSessionUpdate,
} from '@/providers/acp';
import { VibeCLIResolver } from '@/providers/vibe/runtime/VibeCLIResolver';
import { resolveVibeExecutionContext } from '@/providers/vibe/runtime/VibeExecutionContext';
import { findVibeSelectOption, readVibeSelectValues } from '@/providers/vibe/runtime/VibeSessionConfig';

/**
 * Real vibe-acp wire smoke over the production ACP launcher: discovery, the
 * shared initialize handshake, session/config/prompt request shapes, and the
 * notification stream our session logic consumes. Requires an authenticated
 * Vibe installation on the PATH (Vibe resolves its credentials itself); CI
 * images without vibe-acp skip the suite entirely.
 */
let vibeCommand: string | null = null;
try {
  vibeCommand = new VibeCLIResolver().resolveFromSettings(DEFAULT_CLAUDIAN_SETTINGS);
} catch {
  vibeCommand = null;
}
const withVibe = vibeCommand ? describe : describe.skip;

withVibe('Vibe ACP real-process smoke (Windows)', () => {
  it('the production launcher drives live initialize, session, config, prompt and close requests', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vibe-smoke-'));
    let native: ACPNativeProcess | null = null;
    try {
      const { host } = await createProviderHostFixture({
        overrides: {
          getResolvedProviderCliPath: async () => vibeCommand,
          workingDirectory: workspace,
        },
      });
      const context = await resolveVibeExecutionContext(host.getRuntimeHost('vibe'), workspace);
      expect(context.command).toBe(vibeCommand);

      const updates: ACPSessionUpdate[] = [];
      let liveSessionId = '';
      const delegate: ACPClientConnectionDelegate = {
        onSessionNotification: (notification: ACPSessionNotification) => {
          if (liveSessionId && notification.sessionId === liveSessionId) {
            updates.push(notification.update);
          }
        },
        requestPermission: async request => {
          const option = request.options.find(entry => entry.kind === 'allow_once' || entry.kind === 'allow_always');
          return option
            ? { outcome: { optionId: option.optionId, outcome: 'selected' as const } }
            : { outcome: { outcome: 'cancelled' as const } };
        },
        createElicitation: async () => ({ action: 'decline' as const }),
      };

      native = new ACPNativeProcess({
        clientCapabilities: { elicitation: { form: {} } },
        delegate,
        launch: { args: [], command: context.command, cwd: context.hostCwd, env: context.env },
        version: host.getRuntimeHost('vibe').clientVersion ?? 'smoke-test',
      });
      const client = native.client;

      // The server answers with its own protocol version and the session
      // capabilities our execution session relies on (resume + close).
      const initialized = await client.initialize();
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentCapabilities?.loadSession).toBe(true);
      expect(initialized.agentCapabilities?.sessionCapabilities?.close).toBeTruthy();

      const session = await client.newSession({ cwd: context.hostCwd, mcpServers: [] });
      liveSessionId = session.sessionId;
      expect(session.sessionId).toEqual(expect.any(String));
      // The model and thinking selects our configuration logic keys on.
      const modelOption = findVibeSelectOption(session.configOptions, 'model');
      expect(modelOption?.currentValue).toEqual(expect.any(String));
      expect(readVibeSelectValues(session.configOptions, 'thinking')).toEqual(expect.any(Array));

      // A live model turn: the response carries usage and the prompt streamed
      // at least one agent message chunk mentioning the asked-for word.
      const response = await client.prompt({
        prompt: [{ text: 'Reply with exactly: ready', type: 'text' }],
        sessionId: session.sessionId,
      });
      expect(response.stopReason).toEqual(expect.any(String));
      expect(response.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      const agentText = updates
        .filter((update): update is Extract<ACPSessionUpdate, { sessionUpdate: 'agent_message_chunk' }> =>
          update.sessionUpdate === 'agent_message_chunk' && 'content' in update)
        .map(update => (update.content.type === 'text' ? update.content.text : ''))
        .join('');
      expect(agentText).not.toBe('');
      expect(agentText.toLowerCase()).toContain('ready');

      // Every streamed tool update carries the id our normalization
      // demultiplexes on and a status our presentation layer maps.
      const malformedToolUpdates = updates
        .filter((update): update is Extract<ACPSessionUpdate, { sessionUpdate: 'tool_call_update' }> =>
          update.sessionUpdate === 'tool_call_update')
        .filter(update => typeof update.toolCallId !== 'string'
          || (update.status !== undefined && update.status !== null && typeof update.status !== 'string'));
      expect(malformedToolUpdates).toEqual([]);

      // Vibe advertises its slash commands as a session update shortly after
      // session creation; the command probe consumes exactly this stream.
      await vi.waitFor(() => {
        expect(updates.some(update => update.sessionUpdate === 'available_commands_update')).toBe(true);
      }, { timeout: 15_000 });

      // The per-session thinking select round-trips through set_config_option
      // when the current model lists an alternative level; single-level or
      // empty selects stay read-only.
      const thinkingValues = readVibeSelectValues(session.configOptions, 'thinking');
      const thinkingCurrent = findVibeSelectOption(session.configOptions, 'thinking')?.currentValue;
      const thinkingAlternative = thinkingValues.find(value => value !== thinkingCurrent);
      let refreshedThinking: string | undefined;
      if (thinkingAlternative) {
        const switched = await client.setConfigOption({
          configId: 'thinking',
          sessionId: session.sessionId,
          value: thinkingAlternative,
        });
        refreshedThinking = findVibeSelectOption(switched.configOptions, 'thinking')?.currentValue;
      }
      expect(refreshedThinking).toBe(thinkingAlternative);

      await client.closeSession({ sessionId: session.sessionId });
      await native.shutdown();
      expect(native.isAlive()).toBe(false);
    } finally {
      await native?.shutdown().catch(() => undefined);
      await fs.rm(workspace, { force: true, recursive: true });
    }
  }, 240_000);
});

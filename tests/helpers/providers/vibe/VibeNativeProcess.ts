import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { createNativeRPCPeer } from '@test/helpers/providers/NativeRPCTestProcess';

import type {
  ACPRequestPermissionRequest,
  ACPSessionNotification,
} from '@/providers/acp';

/**
 * A fake vibe-acp peer over the real ACP JSON-RPC transport: requests are
 * recorded with implementations configurable per test, and server-initiated
 * notifications (session/update, request/permission) are publishable.
 */
export class VibeNativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly configRequests: Array<{ configId: string; sessionId: string; value?: string }> = [];
  readonly loadRequests: Array<{ cwd: string; sessionId: string }> = [];
  readonly newRequests: Array<{ cwd: string }> = [];
  readonly promptRequests: Array<{ prompt: Array<Record<string, unknown>>; sessionId: string }> = [];
  readonly cancelNotifications: Array<{ sessionId: string }> = [];
  readonly closeRequests: Array<{ sessionId: string }> = [];
  initializeImplementation = async (): Promise<Record<string, unknown>> => ({
    agentInfo: { name: '@mistralai/mistral-vibe', title: 'Mistral Vibe', version: '3.1.3' },
    protocolVersion: 1,
  });
  newImplementation = async (): Promise<Record<string, unknown>> => ({
    sessionId: 'session-new',
    configOptions: [
      { id: 'mode', type: 'select', currentValue: 'default', options: [] },
      {
        id: 'model', type: 'select', currentValue: 'mistral-large-latest',
        options: [{ value: 'mistral-large-latest', name: 'Mistral Large' }],
      },
      {
        id: 'thinking', type: 'select', currentValue: 'high',
        options: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    ],
  });
  loadImplementation = async (): Promise<Record<string, unknown> | null> => null;
  promptImplementation = async (): Promise<Record<string, unknown>> => ({
    stopReason: 'end_turn',
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
  });

  constructor() {
    const peer = createNativeRPCPeer(async (method, params) => {
      switch (method) {
        case 'initialize':
          return this.initializeImplementation();
        case 'session/new': {
          const request = { cwd: String(params.cwd) };
          this.newRequests.push(request as never);
          return this.newImplementation();
        }
        case 'session/load': {
          const request = { cwd: String(params.cwd), sessionId: String(params.sessionId) };
          this.loadRequests.push(request as never);
          const loaded = await this.loadImplementation();
          return loaded ?? { sessionId: request.sessionId, configOptions: [] };
        }
        case 'session/set_config_option':
          this.configRequests.push(params as never);
          return {
            configOptions: this.newConfigOptionsAfter(String(params.configId), String(params.value)),
          };
        case 'session/prompt': {
          const request = {
            prompt: params.prompt as Array<Record<string, unknown>>,
            sessionId: String(params.sessionId),
          };
          this.promptRequests.push(request as never);
          return this.promptImplementation();
        }
        case 'session/close':
          this.closeRequests.push({ sessionId: String(params.sessionId) });
          return {};
        case 'session/list':
          return { sessions: [] };
        default:
          throw new Error('Unexpected native method: ' + method);
      }
    }, (method, params) => {
      if (method === 'session/cancel' && params.sessionId) {
        this.cancelNotifications.push({ sessionId: String(params.sessionId) });
      }
    });
    this.child = peer.child;
    this.request = (method, params) => peer.request(method, params);
    let exitCount = 0;
    this.child.on('exit', () => { exitCount += 1; this.shutdownCalls = exitCount; });
    this.shutdownCalls = 0;
  }

  shutdownCalls = 0;

  /** Config options the peer reports after a set_config_option switch. */
  newConfigOptionsAfter(configId: string, value: string): Array<Record<string, unknown>> {
    const current = configId === 'model' ? value : 'mistral-large-latest';
    const thinkingCurrent = configId === 'thinking' ? value : 'high';
    return [
      {
        id: 'model', type: 'select', currentValue: current,
        options: [{ value: 'mistral-large-latest', name: 'Mistral Large' }, { value: 'magistral-small', name: 'Magistral' }],
      },
      {
        id: 'thinking', type: 'select', currentValue: thinkingCurrent,
        options: thinkingOptionsFor(current),
      },
    ];
  }

  emitSessionUpdate(notification: ACPSessionNotification): void {
    // The transport parses notifications itself; write it as the raw record.
    (this.child.stdout as unknown as { write: (chunk: string) => void })
      .write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: notification })}\n`);
  }

  requestPermission(request: ACPRequestPermissionRequest): Promise<unknown> {
    return this.request('session/request_permission', request);
  }
}

function thinkingOptionsFor(model: string): Array<Record<string, unknown>> {
  return model === 'magistral-small'
    ? [{ value: 'off' }, { value: 'low' }]
    : [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }];
}

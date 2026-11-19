import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { VibeNativeProcess } from '@test/helpers/providers/vibe/VibeNativeProcess';
import spawn from 'cross-spawn';

import {
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionSession,
  type ProviderInteractionPort,
  type ProviderSessionConfig,
} from '@/core/execution';
import { VibeExecutionBackend } from '@/providers/vibe/execution/VibeExecutionBackend';
import { VibeSharedRuntime } from '@/providers/vibe/execution/VibeSharedRuntime';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const sessions: ProviderExecutionSession[] = [];
const processes: VibeNativeProcess[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  vi.mocked(spawn).mockReset();
  processes.length = 0;
});

async function createHost() {
  return (await createProviderHostFixture({
    overrides: {
      getResolvedProviderCliPath: vi.fn(async () => '/vibe/vibe-acp.exe'),
      workingDirectory: '/vault',
    },
    settings: {
      model: 'vibe/mistral-large-latest',
      providerConfigs: {
        vibe: {
          enabled: true,
          discoveredModels: [
            { encodedId: 'vibe/mistral-large-latest', label: 'Mistral Large', rawId: 'mistral-large-latest',
              reasoning: true, reasoningMetadataResolved: true, thinkingLevels: ['off', 'low', 'medium', 'high'] },
            { encodedId: 'vibe/magistral-small', label: 'Magistral', rawId: 'magistral-small',
              reasoning: true, reasoningMetadataResolved: true, thinkingLevels: ['off', 'low'] },
          ],
          visibleModels: ['vibe/mistral-large-latest', 'vibe/magistral-small'],
        },
      },
    },
  })).host;
}

function createConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    interactionPort: createInteractionPort(),
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    workingDirectory: '/vault',
    ...overrides,
  };
}

function createInteractionPort(): ProviderInteractionPort {
  return {
    askUserQuestion: vi.fn(async () => ({ interactionId: 'question-1', answers: {} })),
    dismissInteraction: vi.fn(),
    requestApproval: vi.fn(async () => ({
      interactionId: 'approval-1',
      decision: 'allow' as const,
    })),
  };
}

function createRequest(overrides: Partial<ProviderExecutionRequest> = {}): ProviderExecutionRequest {
  return {
    configuration: {
      model: 'vibe/mistral-large-latest',
      reasoning: 'high',
      systemInstructions: { kind: 'main-agent', instructions: 'Main Agent prompt.' },
    },
    input: [{ text: 'Hello Vibe', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

interface VibeHarness {
  backend: VibeExecutionBackend;
  processes: VibeNativeProcess[];
  runtime: VibeSharedRuntime;
  session: ProviderExecutionSession;
  /** The shared peer, spawned lazily by the first execute; read at use time. */
  native(): VibeNativeProcess | undefined;
}

async function createHarness(
  config = createConfig(),
  createNative: () => VibeNativeProcess = () => new VibeNativeProcess(),
): Promise<VibeHarness> {
  const host = await createHost();
  const runtime = new VibeSharedRuntime();
  const backend = new VibeExecutionBackend(host.getRuntimeHost('vibe'), { sharedRuntime: runtime });
  vi.mocked(spawn).mockImplementation(() => {
    const native = createNative();
    if (!processes.includes(native)) processes.push(native);
    return native.child;
  });
  const session = backend.createSession(config);
  sessions.push(session);
  return { backend, native: () => processes[0], processes, runtime, session };
}

async function collect(
  events: AsyncIterable<ProviderExecutionEvent>,
): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

it('completes a turn over the shared process, applying model and thinking only when they differ', async () => {
  const harness = await createHarness();
  const events = await collect(harness.session.execute(createRequest()).events);
  expect(events.at(-1)).toMatchObject({ type: 'turn_completed', turnStats: { outputTokens: 4 } });
  expect(harness.native()?.newRequests).toEqual([{ cwd: '/vault' }]);
  // Same model as the session's current value, so only thinking applies.
  expect(harness.native()?.configRequests).toEqual([{ configId: 'thinking', sessionId: 'session-new', value: 'high' }]);
  expect(harness.native()?.promptRequests).toEqual([{ prompt: [{ text: 'Hello Vibe', type: 'text' }], sessionId: 'session-new' }]);
  expect(harness.session.getSnapshot().providerSessionId).toBe('session-new');
});

it('switches the model and drops a thinking level the switched model does not list', async () => {
  const harness = await createHarness();
  const events = await collect(harness.session.execute(createRequest({
    configuration: {
      model: 'vibe/magistral-small',
      reasoning: 'high',
      systemInstructions: { kind: 'main-agent', instructions: 'Main Agent prompt.' },
    },
  })).events);
  expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  expect(harness.native()?.configRequests).toEqual([
    { configId: 'model', sessionId: 'session-new', value: 'magistral-small' },
  ]);
});

it('resumes the persisted native session and reports its id once', async () => {
  const harness = await createHarness(createConfig({
    resumeSeed: { providerSessionId: 'session-42' },
  }));
  const events = await collect(harness.session.execute(createRequest({
    configuration: {
      model: 'vibe/mistral-large-latest',
      reasoning: undefined,
      systemInstructions: { kind: 'main-agent', instructions: 'Main Agent prompt.' },
    },
  })).events);
  expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  expect(harness.native()?.loadRequests).toEqual([{ cwd: '/vault', sessionId: 'session-42' }]);
  expect(harness.native()?.newRequests).toEqual([]);
  expect(harness.session.getSnapshot().providerSessionId).toBe('session-42');
});

it('fails a missing native session as recoverable without rebinding', async () => {
  const fake = new VibeNativeProcess();
  fake.loadImplementation = async (): Promise<Record<string, unknown> | null> => {
    throw new Error('Session not found: session-gone');
  };
  const harness = await createHarness(createConfig({
    resumeSeed: { providerSessionId: 'session-gone' },
  }), () => fake);
  const events = await collect(harness.session.execute(createRequest()).events);
  expect(events.at(-1)).toMatchObject({
    type: 'execution_error',
    category: 'provider-session-missing',
    recoverable: true,
  });
  expect(harness.session.getSnapshot().providerSessionId).toBe('session-gone');
});

it('answers a run cancellation through native session/cancel only', async () => {
  const fake = new VibeNativeProcess();
  let releasePrompt!: (value: Record<string, unknown>) => void;
  fake.promptImplementation = () => new Promise<Record<string, unknown>>(resolve => {
    releasePrompt = resolve;
  });
  const harness = await createHarness(createConfig(), () => fake);
  const events: ProviderExecutionEvent[] = [];
  const flight = (async () => {
    for await (const event of harness.session.execute(createRequest()).events) {
      events.push(event);
    }
  })();
  await vi.waitFor(() => { expect(harness.native()?.promptRequests.length).toBe(1); });
  harness.session.cancel();
  releasePrompt({ stopReason: 'cancelled', usage: null });
  await flight;
  expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
  expect(harness.native()?.cancelNotifications).toEqual([{ sessionId: 'session-new' }]);
  expect(harness.native()?.shutdownCalls).toBe(0);
});

it('serves two sessions from one process and demultiplexes their notifications', async () => {
  const harness = await createHarness();
  const second = harness.backend.createSession(createConfig());
  sessions.push(second);

  const firstEvents: ProviderExecutionEvent[] = [];
  const secondEvents: ProviderExecutionEvent[] = [];
  const firstFlight = (async () => {
    for await (const event of harness.session.execute(createRequest()).events) {
      firstEvents.push(event);
    }
  })();
  const secondFlight = (async () => {
    for await (const event of second.execute(createRequest()).events) {
      secondEvents.push(event);
    }
  })();
  await Promise.all([firstFlight, secondFlight]);
  expect(harness.processes).toHaveLength(1);
  expect(harness.native()?.newRequests).toHaveLength(2);
  expect(firstEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
  expect(secondEvents.at(-1)).toMatchObject({ type: 'turn_completed' });
  await harness.runtime.shutdown();
});

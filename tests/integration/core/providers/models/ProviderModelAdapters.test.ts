import { assertCatalogModelAvailable, modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { PiNativeProcess } from '@test/helpers/providers/pi/PiNativeProcess';
import spawn from 'cross-spawn';

import type { ProviderModelCatalog } from '@/core/providers/models/ProviderModelCatalog';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ACPClientConnection } from '@/providers/acp';
import { createClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { createDeepSeekModels } from '@/providers/deepseek/runtime/DeepSeekModels';
import { createGrokModels } from '@/providers/grok/runtime/GrokModels';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { createPiModels } from '@/providers/pi/runtime/PiModels';
import { getPiProviderSettings } from '@/providers/pi/settings';
import type { VibeSharedRuntime } from '@/providers/vibe/execution/VibeSharedRuntime';
import { createVibeModels } from '@/providers/vibe/runtime/VibeModels';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const browseOrders = {
  deepseek: ['deepseek:native/selected', 'deepseek:native/unselected-catalog-entry'],
  claude: ['sonnet', 'unselected-catalog-entry'],
  codex: ['gpt-5.5', 'unselected-catalog-entry'],
  grok: ['selected', 'unselected-catalog-entry'],
  opencode: ['unselected-catalog-entry', 'anthropic/selected'],
  pi: ['pi:anthropic/unselected-catalog-entry', 'pi:anthropic/selected'],
  vibe: ['vibe/selected', 'vibe/unselected-catalog-entry'],
};

/** One shared-runtime fake per Vibe model discovery; newSession counts its native queries. */
function createVibeModelCatalogRuntime(): { runtime: VibeSharedRuntime; sessions: ACPClientConnection[] } {
  const sessions: ACPClientConnection[] = [];
  const client: ACPClientConnection = {
    newSession: async () => {
      sessions.push(client);
      return {
        sessionId: `vibe-discovery-${sessions.length}`,
        configOptions: [{
          id: 'model',
          type: 'select',
          currentValue: 'selected',
          options: [
            { value: 'selected', name: 'Selected label', description: 'Selected metadata' },
            { value: 'unselected-catalog-entry', name: 'Unselected', description: '' },
          ],
        }],
      };
    },
    closeSession: async () => ({}),
  } as unknown as ACPClientConnection;
  const owner = {
    contextKey: 'test',
    initialized: true,
    initializeFlight: null,
    native: { client },
    shutdownFlight: null,
  };
  const runtime = {
    acquire: async () => owner,
    ensureInitialized: async () => undefined,
  } as unknown as VibeSharedRuntime;
  return { runtime, sessions };
}

it.each(modelCatalogCases)('$id keeps native selection, aliases and metadata behind the common catalog', async ({id, selected, populate, read}) => {
  const persist = vi.fn(async () => undefined);
  const fixture = await createProviderHostFixture({ beforePersist: persist });
  const { settings } = fixture;
  populate(settings);
  const host = fixture.host.getRuntimeHost(id);
  const discovery = vi.fn(async () => ({ changed: true, refreshed: true, kind: 'completed' as const, catalog: null, models: [], persistedSettingsChanged: false }));
  const warmModelsMetadata = vi.fn(async () => true);
  const vibeModelRuntime = id === 'vibe' ? createVibeModelCatalogRuntime() : null;
  const peers: PiNativeProcess[] = [];
  vi.mocked(spawn).mockImplementation(() => {
    const models = getPiProviderSettings(settings).discoveredModels.map(model => ({ ...model, name: model.label }));
    const peer = new PiNativeProcess({}, new Map([['get_available_models', { models }]]));
    peers.push(peer);
    return peer.child;
  });
  onTestFinished(() => {
    for (const peer of peers) {
      peer.child.stdin.destroy(); peer.child.stdout.destroy(); peer.child.stderr.destroy();
    }
    vi.mocked(spawn).mockReset();
  });
  const factories: Record<string, () => ProviderModelCatalog> = {
    deepseek: () => createDeepSeekModels(host, async () => { await discovery(); return { groups: [{ id: 'native', models: [{ id: 'selected', name: 'Selected label' }, { id: 'unselected-catalog-entry', name: 'Unselected' }] }] }; }),
    claude: () => createClaudeModels(host, discovery),
    codex: () => createCodexModels(host, { refresh: discovery }),
    grok: () => createGrokModels(host, { refresh: discovery }),
    opencode: () => createOpencodeModels(host, { discoverModels: discovery, warmModelsMetadata, observeCatalog: () => () => undefined }),
    pi: () => createPiModels(host),
    vibe: () => createVibeModels(host, () => vibeModelRuntime?.runtime).catalog,
  };
  const catalog = factories[id]();
  const discoveredModels = structuredClone(read(settings));
  expect(catalog.getSnapshot().models.map(model => model.id)).toEqual(browseOrders[id]);
  expect(read(settings)).toEqual(discoveredModels);
  const selectedId = catalog.getSnapshot().selectedIds[0];
  expect(catalog.getSnapshot().defaultModelId).toBe(selectedId);
  expect(() => assertCatalogModelAvailable(id, host, selected)).not.toThrow();
  await catalog.refresh();
  const discoveryCount = () => id === 'pi'
    ? peers.length
    : id === 'vibe'
      ? (vibeModelRuntime?.sessions.length ?? 0)
      : discovery.mock.calls.length;
  const calls = discoveryCount();
  catalog.markStale();
  await catalog.refresh();
  expect(discoveryCount()).toBe(calls);
  expect(catalog.getSnapshot()).toMatchObject({ stale: true, discoveredCount: 2, selectedIds: [selectedId] });
  await catalog.refresh({ force: true });
  expect(discoveryCount()).toBe(calls + 1);
  await catalog.setAlias(selectedId, 'My selected model');
  expect(catalog.getSnapshot().aliases[selectedId]).toBe('My selected model');
  await catalog.changeSelection({ type: 'clear' });
  expect(catalog.getSnapshot().selectedIds).toEqual([]);
  expect(() => assertCatalogModelAvailable(id, host, selected)).toThrow(ProviderModelUnavailableError);
  await catalog.changeSelection({ type: 'set', modelId: selectedId, selected: true });
  expect(warmModelsMetadata.mock.calls).toEqual(id === 'opencode'
    ? [[[]], [[selected]]] : []);
  const before = structuredClone(settings);
  persist.mockRejectedValueOnce(new Error('disk full'));
  await expect(catalog.changeSelection({ type: 'clear' })).rejects.toThrow('disk full');
  expect(settings).toEqual(before);
  expect(catalog.getSnapshot().selectedIds).toEqual([selectedId]);
  await catalog.dispose();
});

it('preserves OpenCode provider labels for catalog filtering', async () => {
  const fixture = await createProviderHostFixture({ settings: { providerConfigs: { opencode: {
    visibleModels: [], discoveredModels: [
      { rawId: 'anthropic/sonnet', label: 'Anthropic/Sonnet' },
      { rawId: 'openai/gpt', label: 'OpenAI/GPT' },
    ],
  } } } });
  const host = fixture.host.getRuntimeHost('opencode');
  const catalog = createOpencodeModels(host, { discoverModels: vi.fn(), warmModelsMetadata: vi.fn(), observeCatalog: () => () => undefined });
  expect(catalog.getSnapshot().models).toEqual([
    expect.objectContaining({ id: 'openai/gpt', name: 'GPT', providerKey: 'openai', providerLabel: 'OpenAI' }),
    expect.objectContaining({ id: 'anthropic/sonnet', name: 'Sonnet', providerKey: 'anthropic', providerLabel: 'Anthropic' }),
  ]);
});

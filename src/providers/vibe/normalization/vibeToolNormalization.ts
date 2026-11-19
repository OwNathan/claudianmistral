import {
  type ACPResolvedToolRawName,
  ACPToolStreamAdapter,
  type ACPToolStreamPresentationAdapter,
} from '@/providers/acp/ACPToolStreamAdapter';

/** ACP tool kinds mapped to Vibe's tool families; unknown kinds fall back to `other`. */
export const VIBE_TOOL_KIND_NAMES: Readonly<Record<string, string>> = Object.freeze({
  delete: 'delete',
  edit: 'edit',
  execute: 'bash',
  fetch: 'fetch',
  move: 'move',
  other: 'other',
  read: 'read',
  search: 'search',
  switch_mode: 'switch_mode',
  think: 'think',
});

/**
 * Vibe tool presentation: ACP titles lead, kinds back them up, and raw payloads
 * stay attached so native results remain replayable. Vibe has no extension-only
 * dispatcher tools today, so input and output content pass through unchanged.
 */
export class VibeToolStreamPresentationAdapter implements ACPToolStreamPresentationAdapter {
  normalizeToolInput(
    _rawName: string | undefined,
    input: Record<string, unknown>,
    _rawOutput?: unknown,
  ): Record<string, unknown> {
    return input;
  }

  normalizeToolName(rawName: string | undefined, _rawInput?: unknown, _rawOutput?: unknown): string {
    return rawName ?? 'tool';
  }

  normalizeToolResultDetails(): undefined {
    return undefined;
  }

  resolveRawToolName(
    current: ACPResolvedToolRawName | undefined,
    update: { kind?: string | null; title?: string | null },
  ): ACPResolvedToolRawName {
    if (update.title?.trim()) {
      return { provenance: 'title', rawName: update.title };
    }
    if (current) {
      return current;
    }
    const kindName = update.kind ? VIBE_TOOL_KIND_NAMES[update.kind] ?? 'other' : 'other';
    return { provenance: 'kind', rawName: kindName };
  }
}

export function createVibeToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter(new VibeToolStreamPresentationAdapter());
}

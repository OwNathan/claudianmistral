import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChatMessage, ToolCallInfo } from '../../../core/types';
import { readFileRevision } from '../../../utils/fileRevision';

/** A history read's outcome: readable records, plus how many chunk files were skipped. */
export interface ParsedVibeHistory {
  readonly messages: ChatMessage[];
  readonly invalidChunkCount: number;
}

interface VibeChunkRecord {
  readonly createdAt?: number;
  readonly content?: { text?: unknown; type?: unknown }[];
  readonly generationStatus?: string;
  readonly id?: string;
  readonly role?: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly turnId?: string;
  readonly type?: string;
  readonly detail?: {
    readonly input?: unknown;
    readonly kind?: string;
    readonly toolName?: string;
  };
}

const CHUNKS_DIR = 'chunks';

/**
 * Fail-soft reader for Vibe's on-disk session records.
 *
 * The chunk format is undocumented and can drift between Vibe versions: every
 * unreadable chunk file is skipped and counted, and an unparseable session
 * yields empty messages rather than an error. A turn stops at the assistant
 * message chosen by `resumeAtMessageId` (record ids).
 */
export async function loadVibeHistory(
  sessionDirectory: string,
  sessionId: string,
  resumeAtMessageId?: string | null,
): Promise<ParsedVibeHistory> {
  const { invalidChunkCount, records } = await readChunkRecords(sessionDirectory);
  const ordered = records
    .filter(isRenderableRecord)
    .sort((left, right) => compareRecords(left, right));

  const messages: ChatMessage[] = [];
  let userMessage: ChatMessage | null = null;
  let assistantTexts: string[] = [];
  let thinking: string[] = [];
  let toolCalls: ToolCallInfo[] = [];
  let assistantRecordId: string | null = null;
  let assistantTimestamp: number | null = null;
  let assistantCompletedAt: number | null = null;

  const pushAssistant = (): void => {
    if (!userMessage || (assistantTexts.length === 0 && toolCalls.length === 0)) {
      return;
    }
    const content = assistantTexts.join('\n\n');
    messages.push({
      assistantMessageId: assistantRecordId ?? undefined,
      content,
      ...(thinking.length > 0
        ? { contentBlocks: thinking.map(text => ({ content: text, type: 'thinking' })) }
        : {}),
      completedAt: assistantCompletedAt ?? undefined,
      id: assistantRecordId ?? `${userMessage.id}-assistant`,
      role: 'assistant',
      timestamp: assistantTimestamp ?? userMessage.timestamp,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      turnId: userMessage.turnId,
    });
    assistantTexts = [];
    thinking = [];
    toolCalls = [];
    assistantRecordId = null;
    assistantTimestamp = null;
    assistantCompletedAt = null;
  };

  for (const record of ordered) {
    if (record.role === 'user' && record.type === 'message') {
      pushAssistant();
      const text = readRecordText(record);
      if (!text) {
        continue;
      }
      userMessage = {
        content: text,
        id: record.id ?? `vibe-${sessionId}-user-${messages.length}`,
        role: 'user',
        timestamp: normalizedTimestamp(record.createdAt) ?? 0,
        turnId: record.turnId,
        userMessageId: record.id,
      };
      messages.push(userMessage);
      continue;
    }

    if (!userMessage) {
      // Records before the first user turn belong to no replayed turn.
      continue;
    }

    if (record.type === 'reasoning' && typeof record.text === 'string' && record.text.trim()) {
      thinking.push(record.text);
      continue;
    }

    if (record.type === 'effect' && record.detail?.kind === 'tool' && record.detail.toolName) {
      const toolCall = buildEffectToolCall(record, sessionId);
      if (toolCall) {
        toolCalls.push(toolCall);
        assistantCompletedAt = normalizedTimestamp(record.createdAt) ?? assistantCompletedAt;
      }
      continue;
    }

    if (record.role === 'assistant' && record.type === 'message') {
      const text = readRecordText(record);
      if (text) {
        assistantTexts.push(text);
        assistantRecordId ??= record.id ?? null;
        assistantTimestamp ??= normalizedTimestamp(record.createdAt) ?? null;
      }
      assistantCompletedAt = normalizedTimestamp(record.createdAt) ?? assistantCompletedAt;
      if (resumeAtMessageId && record.id === resumeAtMessageId) {
        break;
      }
    }
  }
  pushAssistant();

  return { invalidChunkCount, messages };
}

/** Opaque revision token over the session directory; null when unreachable. */
export async function readVibeHistoryRevision(sessionDirectory: string): Promise<string | null> {
  const revision = await readFileRevision(path.join(sessionDirectory, 'meta.json'));
  if (revision) {
    return revision;
  }
  try {
    const stats = await fs.stat(path.join(sessionDirectory, CHUNKS_DIR));
    return stats.isDirectory() ? `${stats.size}:${stats.mtimeMs}` : null;
  } catch {
    return null;
  }
}

async function readChunkRecords(
  sessionDirectory: string,
): Promise<{ invalidChunkCount: number; records: VibeChunkRecord[] }> {
  const chunksDir = path.join(sessionDirectory, CHUNKS_DIR);
  let entries: string[];
  try {
    entries = (await fs.readdir(chunksDir)).filter(name => name.endsWith('.json'));
  } catch {
    return { invalidChunkCount: 0, records: [] };
  }

  let invalidChunkCount = 0;
  const records: VibeChunkRecord[] = [];
  for (const entry of entries) {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(path.join(chunksDir, entry), 'utf8'));
      if (!Array.isArray(raw)) {
        continue;
      }
      for (const record of raw) {
        if (isChunkRecord(record)) {
          records.push(record);
        }
      }
    } catch {
      // Undocumented format: unreadable chunk files disappear from hydration.
      invalidChunkCount += 1;
    }
  }
  return { invalidChunkCount, records };
}

function isChunkRecord(value: unknown): value is VibeChunkRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRenderableRecord(record: VibeChunkRecord): boolean {
  return (record.role === 'user' || record.role === 'assistant') && record.type === 'message'
    || record.type === 'reasoning'
    || record.type === 'effect';
}

function compareRecords(left: VibeChunkRecord, right: VibeChunkRecord): number {
  const leftAt = normalizedTimestamp(left.createdAt) ?? 0;
  const rightAt = normalizedTimestamp(right.createdAt) ?? 0;
  return leftAt - rightAt || (left.id ?? '').localeCompare(right.id ?? '');
}

function readRecordText(record: VibeChunkRecord): string | null {
  const blocks = Array.isArray(record.content) ? record.content : [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === 'object' && typeof block.text === 'string' && block.text) {
      texts.push(block.text);
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

function buildEffectToolCall(record: VibeChunkRecord, sessionId: string): ToolCallInfo | null {
  const toolName = record.detail?.toolName;
  if (!toolName) {
    return null;
  }
  const detailInput = record.detail.input;
  return {
    id: record.id ?? `vibe-${sessionId}-effect-${toolName}`,
    input: detailInput && typeof detailInput === 'object' && !Array.isArray(detailInput)
      ? detailInput as Record<string, unknown>
      : {},
    name: toolName,
    status: record.generationStatus === 'failed' ? 'error' : 'completed',
  };
}

function normalizedTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

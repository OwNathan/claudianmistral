import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate } from '@test/helpers/testClock';

import { loadVibeHistory, readVibeHistoryRevision } from '@/providers/vibe/history/VibeHistoryStore';

/** One shared timeline; record timestamps and message assertions derive from it. */
const BASE_MS = testDate().getTime();
const at = (seconds: number): number => BASE_MS + seconds * 1000;

interface ChunkFile {
  readonly name: string;
  /** A JSON array of chunk records, or raw file content for malformed files. */
  readonly content: readonly unknown[] | string;
}

/**
 * Creates a Vibe session directory with per-file chunk contents, removed after each test.
 */
function useVibeSessionDirectory() {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
  });
  return async (files: readonly ChunkFile[], meta?: string) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vibe-history-'));
    directories.push(directory);
    if (meta !== undefined) await fs.writeFile(path.join(directory, 'meta.json'), meta);
    const chunksDirectory = path.join(directory, 'chunks');
    await fs.mkdir(chunksDirectory, { recursive: true });
    for (const file of files) {
      await fs.writeFile(
        path.join(chunksDirectory, file.name),
        typeof file.content === 'string' ? file.content : JSON.stringify(file.content),
      );
    }
    return directory;
  };
}

const writeSession = useVibeSessionDirectory();

const userRecord = (id: string, text: string, seconds: number, turnId = 'turn-1') => ({
  role: 'user', type: 'message', id, createdAt: at(seconds), turnId,
  content: [{ type: 'text', text }],
});

const assistantRecord = (id: string, text: string, seconds: number) => ({
  role: 'assistant', type: 'message', id, createdAt: at(seconds),
  content: [{ type: 'text', text }],
});

const reasoningRecord = (id: string, text: string, seconds: number) => ({
  type: 'reasoning', id, createdAt: at(seconds), text,
});

const effectRecord = (id: string, seconds: number, status: string, toolName: string) => ({
  type: 'effect', id, createdAt: at(seconds), generationStatus: status,
  detail: { kind: 'tool', toolName, input: { path: '/vault/note.md' } },
});

it('assembles one turn from a session into user and assistant messages with native identity', async () => {
  const directory = await writeSession([
    {
      name: 'chunk-000.json',
      content: [
        userRecord('u1', 'Format the weekly note.', 0, 'turn-1'),
        reasoningRecord('r1', 'Reading the note first.', 1),
        effectRecord('fx-1', 2, 'completed', 'read_note'),
        effectRecord('fx-2', 3, 'failed', 'write_note'),
        assistantRecord('a1', 'Done.', 4),
      ],
    },
  ]);

  const { invalidChunkCount, messages } = await loadVibeHistory(directory, 'session-42');

  expect(invalidChunkCount).toBe(0);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    id: 'u1', role: 'user', userMessageId: 'u1', turnId: 'turn-1',
    content: 'Format the weekly note.', timestamp: at(0),
  });
  expect(messages[1]).toMatchObject({
    id: 'a1', role: 'assistant', assistantMessageId: 'a1', turnId: 'turn-1',
    content: 'Done.',
    timestamp: at(4),
    completedAt: at(4),
    contentBlocks: [{ type: 'thinking', content: 'Reading the note first.' }],
    toolCalls: [
      { id: 'fx-1', name: 'read_note', input: { path: '/vault/note.md' }, status: 'completed' },
      { id: 'fx-2', name: 'write_note', input: { path: '/vault/note.md' }, status: 'error' },
    ],
  });
});

it('orders turns across interleaved chunk files by record time, not file or array order', async () => {
  const directory = await writeSession([
    {
      name: 'chunk-001.json',
      content: [
        assistantRecord('a2', 'Second reply.', 90),
        userRecord('u2', 'Second request.', 60, 'turn-2'),
      ],
    },
    {
      name: 'chunk-000.json',
      content: [
        assistantRecord('a1', 'First reply.', 30),
        userRecord('u1', 'First request.', 0, 'turn-1'),
      ],
    },
  ]);

  const { messages } = await loadVibeHistory(directory, 'session-42');

  expect(messages.map(message => message.content)).toEqual([
    'First request.', 'First reply.', 'Second request.', 'Second reply.',
  ]);
  expect(messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
});

it('drops stray records and ignores unknown record kinds instead of replaying them', async () => {
  const directory = await writeSession([
    {
      name: 'chunk-000.json',
      content: [
        effectRecord('fx-stray', 0, 'completed', 'read_note'),
        assistantRecord('a-stray', 'No turn yet.', 1),
        { role: 'user', type: 'message', id: 'u-empty', createdAt: at(2), turnId: 'turn-empty', content: [] },
        userRecord('u1', 'Summarize.', 3, 'turn-1'),
        {
          type: 'effect', id: 'fx-note', createdAt: at(4), generationStatus: 'completed',
          detail: { kind: 'notification', toolName: 'notify', input: {} },
        },
        { role: 'assistant', type: 'message', id: 'a-blank', createdAt: at(5), content: [] },
      ],
    },
  ]);

  const { messages } = await loadVibeHistory(directory, 'session-42');

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ id: 'u1', role: 'user', content: 'Summarize.' });
});

it('skips unreadable chunk files while keeping readable records from the same session dir', async () => {
  const directory = await writeSession([
    { name: 'zz-mixed.json', content: [
      userRecord('u2', 'Second request.', 10),
      'a bare string is not a record',
      null,
      assistantRecord('a2', 'Second reply.', 11),
    ] },
    { name: 'not-an-array.json', content: '{"role":"user"}' },
    { name: 'unreadable.json', content: '{not json' },
    { name: 'chunk-000.json', content: [
      userRecord('u1', 'First request.', 0),
      assistantRecord('a1', 'First reply.', 1),
    ] },
  ]);

  const { invalidChunkCount, messages } = await loadVibeHistory(directory, 'session-42');

  // Only the unparseable file is invalid; a non-array file and non-object entries are skipped.
  expect(invalidChunkCount).toBe(1);
  expect(messages.map(message => message.content)).toEqual([
    'First request.', 'First reply.', 'Second request.', 'Second reply.',
  ]);
});

it('stops the replay at the assistant record named by resumeAtMessageId', async () => {
  const directory = await writeSession([
    {
      name: 'chunk-000.json',
      content: [
        userRecord('u1', 'First request.', 0, 'turn-1'),
        assistantRecord('a1', 'First reply.', 1),
        userRecord('u2', 'Second request.', 10, 'turn-2'),
        reasoningRecord('r2', 'Checking the outline.', 11),
        effectRecord('fx-2', 12, 'completed', 'read_note'),
        assistantRecord('a2', 'Partial reply.', 13),
        assistantRecord('a3', 'Never replayed.', 14),
      ],
    },
  ]);

  const { messages } = await loadVibeHistory(directory, 'session-42', 'a2');

  expect(messages).toHaveLength(4);
  expect(messages[3]).toMatchObject({
    id: 'a2', role: 'assistant', turnId: 'turn-2', content: 'Partial reply.',
    contentBlocks: [{ type: 'thinking', content: 'Checking the outline.' }],
    toolCalls: [{ id: 'fx-2', name: 'read_note', status: 'completed' }],
  });
  expect(messages.some(message => message.content === 'Never replayed.')).toBe(false);
});

it('reads a session without a chunks directory as empty and reports no usable revision', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vibe-history-empty-'));
  try {
    const missing = path.join(directory, 'no-such-session');
    expect(await loadVibeHistory(missing, 'session-42')).toEqual({ invalidChunkCount: 0, messages: [] });
    expect(await readVibeHistoryRevision(missing)).toBeNull();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('revisions the session through meta.json before falling back to the chunks directory', async () => {
  const chunksOnly = await writeSession([{
    name: 'chunk-000.json', content: [userRecord('u1', 'Hello.', 0), assistantRecord('a1', 'Hi.', 1)],
  }]);
  const chunksRevision = await readVibeHistoryRevision(chunksOnly);
  expect(chunksRevision).toEqual(expect.any(String));

  const withMeta = await writeSession([{
    name: 'chunk-000.json', content: [userRecord('u1', 'Hello.', 0)],
  }], 'x'.repeat(50));
  const metaRevision = await readVibeHistoryRevision(withMeta);
  // The meta.json file is the revision source: its size leads the token.
  expect(metaRevision).toMatch(/^50:/);
});

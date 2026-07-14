import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('API mode boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('subscribes to the authenticated SSE stream and closes it on cleanup', () => {
    class EventSourceMock {
      static instance: EventSourceMock | null = null;
      readonly url: string;
      readonly withCredentials: boolean;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      close = vi.fn();

      constructor(url: string | URL, init?: EventSourceInit) {
        this.url = String(url);
        this.withCredentials = init?.withCredentials ?? false;
        EventSourceMock.instance = this;
      }
    }
    vi.stubGlobal('EventSource', EventSourceMock);
    const listener = vi.fn();
    const unsubscribe = createApi(false).subscribeEvents(listener);
    const source = EventSourceMock.instance!;
    const event = {
      id: 12,
      topic: 'whatsapp',
      eventType: 'whatsapp.state.changed',
      payload: { status: 'connected' },
      createdAt: '2026-07-13T12:00:00.000Z',
    };

    expect(source.url).toBe('/api/events');
    expect(source.withCredentials).toBe(true);
    source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
    expect(listener).toHaveBeenCalledWith(event);
    source.onmessage?.(new MessageEvent('message', { data: '{invalid-json' }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('keeps event subscriptions inert in preview mode', () => {
    const eventSource = vi.fn();
    vi.stubGlobal('EventSource', eventSource);
    const listener = vi.fn();
    const unsubscribe = createApi(true).subscribeEvents(listener);

    unsubscribe();
    expect(eventSource).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('never replaces a real API failure with demo data', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ message: 'Serviço indisponível' }, 503));
    vi.stubGlobal('fetch', fetchMock);

    const api = createApi(false);
    await expect(api.getWorkspace()).rejects.toMatchObject({ status: 503, message: 'Serviço indisponível' } satisfies Partial<ApiError>);
    expect(api.isPreview).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/bootstrap', expect.objectContaining({ credentials: 'include' }));
  });

  it('serves demo content only from explicit preview mode', async () => {
    const api = createApi(true);
    const workspace = await api.getWorkspace();
    expect(api.isPreview).toBe(true);
    expect(workspace.greeting).toContain('Marina');
    expect(workspace.notes.length).toBeGreaterThan(0);
  });

  it('uses the delegated Trello authorization contract', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ authorizeUrl: 'https://trello.com/1/authorize', state: 'state-1', expiresAt: '2026-07-13T12:00:00Z' }));
    vi.stubGlobal('fetch', fetchMock);

    const api = createApi(false);
    await expect(api.startTrelloAuthorization()).resolves.toEqual({ authorizationUrl: 'https://trello.com/1/authorize' });
    expect(fetchMock).toHaveBeenCalledWith('/api/trello/authorize', expect.objectContaining({ credentials: 'include' }));
  });

  it('parses Trello item collections and maps completed to doneListId', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/trello/connections') return jsonResponse({ items: [{ id: 'connection-1', displayName: 'Marina Trello' }] });
      if (url === '/api/trello/connections/connection-1/boards') return jsonResponse({ items: [{ id: 'board-1', name: 'Projetos' }] });
      if (url === '/api/trello/boards/board-1/lists?connectionId=connection-1') return jsonResponse({ items: [{ id: 'inbox', name: 'Entrada' }, { id: 'doing', name: 'Fazendo' }, { id: 'paused', name: 'Pausado' }, { id: 'done', name: 'Feito' }] });
      if (url === '/api/trello/boards/board-1/mapping' && init?.method === 'PUT') return jsonResponse({ ok: true });
      return jsonResponse({ message: `Unexpected ${url}` }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi(false);

    const setup = await api.getTrelloSetup();
    expect(setup).toMatchObject({ connected: true, connectionId: 'connection-1', accountName: 'Marina Trello', boards: [{ id: 'board-1', name: 'Projetos' }] });
    const withLists = await api.selectTrelloBoard('board-1');
    expect(withLists.lists).toHaveLength(4);
    await api.saveTrelloMapping({ boardId: 'board-1', mapping: { inbox: 'inbox', inProgress: 'doing', paused: 'paused', completed: 'done' } });

    const mappingCall = fetchMock.mock.calls.find(([url]) => url === '/api/trello/boards/board-1/mapping');
    expect(JSON.parse(String(mappingCall?.[1]?.body))).toEqual({ connectionId: 'connection-1', boardName: 'Projetos', inboxListId: 'inbox', inProgressListId: 'doing', pausedListId: 'paused', doneListId: 'done' });
  });

  it('serializes AI corrections using the feedback API contract', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => jsonResponse({ id: 'feedback-1', kind: 'ai_correction' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi(false);
    const noteId = '55555555-5555-4555-8555-555555555555';

    await expect(api.sendFeedback({ itemId: noteId, action: 'not_task', context: 'inbox' })).resolves.toEqual({ accepted: true });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      itemId: noteId,
      action: 'not_task',
      context: 'inbox',
      kind: 'ai_correction',
    });
  });

  it('uses tenant chat-group endpoints and sends explicit monitoring changes', async () => {
    const chatId = '55555555-5555-4555-8555-555555555555';
    const groupId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/whatsapp/chat-groups') return jsonResponse([{ id: groupId, name: 'Trabalho', description: '', color: '#7C5CFF', system: true, chatCount: 1, monitoredCount: 1 }]);
      if (url === `/api/whatsapp/chats/${chatId}`) return jsonResponse({ id: chatId, selected: true });
      return jsonResponse({ message: `Unexpected ${url}` }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi(false);

    await expect(api.listChatGroups()).resolves.toMatchObject([{ id: groupId, name: 'Trabalho' }]);
    await api.updateChat(chatId, { enabled: true, groupId });

    expect(fetchMock).toHaveBeenCalledWith(`/api/whatsapp/chats/${chatId}`, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ enabled: true, groupId }),
    }));
  });

  it('resolves a Trello conflict explicitly and normalizes its sync state', async () => {
    const taskId = '55555555-5555-4555-8555-555555555555';
    const fetchMock = vi.fn(() => jsonResponse({
      resolution: 'keep_atlas',
      syncStatus: 'pending',
      task: {
        id: taskId,
        title: 'Revisar proposta',
        status: 'open',
        priority: 'high',
        trello: { cardId: 'card-1', url: 'https://trello.com/c/card-1', syncStatus: 'pending' },
        metadata: {},
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const task = await createApi(false).resolveTaskConflict(taskId, 'keep_atlas');

    expect(task).toMatchObject({ id: taskId, trelloCardId: 'card-1', trelloSyncStatus: 'pending' });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${taskId}/conflict`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ resolution: 'keep_atlas' }),
      }),
    );
  });
});

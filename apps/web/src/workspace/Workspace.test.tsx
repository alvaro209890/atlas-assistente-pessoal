import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../api';
import { demoSession, demoWorkspace } from '../demo';
import type { AppEvent, WorkspaceData } from '../types';
import { Workspace } from './Workspace';

const cloneWorkspace = (): WorkspaceData => structuredClone(demoWorkspace);

describe('Workspace live updates', () => {
  it('debounces SSE refreshes and keeps current content visible while refreshing', async () => {
    const api = createApi(true);
    let eventListener: ((event: AppEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    api.subscribeEvents = vi.fn((listener) => {
      eventListener = listener;
      return unsubscribe;
    });

    let resolveRefresh!: (workspace: WorkspaceData) => void;
    const refreshed = { ...cloneWorkspace(), briefing: 'Briefing atualizado pelo evento em tempo real.' };
    api.getWorkspace = vi.fn()
      .mockResolvedValueOnce(cloneWorkspace())
      .mockImplementationOnce(() => new Promise<WorkspaceData>((resolve) => { resolveRefresh = resolve; }));

    const view = render(
      <Workspace
        api={api}
        session={demoSession}
        onLogout={vi.fn(async () => undefined)}
        onEnterPreview={vi.fn()}
        onExitPreview={vi.fn()}
      />,
    );

    expect(await screen.findByText(demoWorkspace.briefing)).toBeInTheDocument();
    const event: AppEvent = {
      id: 41,
      topic: 'ai',
      eventType: 'brain.memory.updated',
      payload: { count: 1 },
      createdAt: '2026-07-13T12:00:00.000Z',
    };
    act(() => {
      eventListener?.(event);
      eventListener?.({ ...event, id: 42 });
      eventListener?.({ ...event, id: 43 });
    });

    await waitFor(() => expect(api.getWorkspace).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(screen.getByText(demoWorkspace.briefing)).toBeInTheDocument();
    expect(screen.queryByLabelText('Carregando seu espaço')).not.toBeInTheDocument();

    await act(async () => resolveRefresh(refreshed));
    expect(await screen.findByText(refreshed.briefing)).toBeInTheDocument();
    expect(api.getWorkspace).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('exposes clear labels and current state in the selectable navigation', async () => {
    window.location.hash = '';
    const api = createApi(true);
    api.getWorkspace = vi.fn(async () => cloneWorkspace());

    render(
      <Workspace
        api={api}
        session={demoSession}
        onLogout={vi.fn(async () => undefined)}
        onEnterPreview={vi.fn()}
        onExitPreview={vi.fn()}
      />,
    );

    await screen.findByText(demoWorkspace.briefing);
    const today = screen.getByRole('button', { name: /HojePrioridades do dia/ });
    const trello = screen.getByRole('button', { name: /TrelloQuadro sincronizado/ });
    expect(today).toHaveAttribute('aria-current', 'page');
    expect(trello).not.toHaveAttribute('aria-current');

    fireEvent.click(trello);
    expect(trello).toHaveAttribute('aria-current', 'page');
    expect(today).not.toHaveAttribute('aria-current');
  });
});

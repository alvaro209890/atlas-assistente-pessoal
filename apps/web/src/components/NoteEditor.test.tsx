import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Note } from '../types';
import { NoteEditor } from './NoteEditor';

const note: Note = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Nota inicial',
  excerpt: 'Conteúdo inicial',
  updatedAt: 'agora',
  tags: [],
  source: 'manual',
  contentMarkdown: '# Nota inicial\n\nConteúdo inicial',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('NoteEditor autosave', () => {
  it('drains edits made while an older save is still in flight', async () => {
    const firstSave = deferred<Note>();
    const onSave = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementation(async (_id: string, input: { title: string; contentMarkdown: string }) => ({ ...note, ...input }));
    render(<NoteEditor note={note} onSave={onSave} />);

    const title = await screen.findByRole('textbox', { name: 'Título da nota' });
    fireEvent.change(title, { target: { value: 'Primeira versão' } });
    fireEvent.keyDown(title.closest('article')!, { key: 's', ctrlKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    fireEvent.change(title, { target: { value: 'Versão mais recente' } });
    await act(async () => {
      firstSave.resolve({ ...note, title: 'Primeira versão' });
      await firstSave.promise;
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[1]).toMatchObject({ title: 'Versão mais recente' });
  });

  it('flushes pending changes when the editor unmounts before the debounce', async () => {
    const onSave = vi.fn(async (_id: string, input: { title: string; contentMarkdown: string }) => ({ ...note, ...input }));
    const view = render(<NoteEditor note={note} onSave={onSave} />);
    const title = await screen.findByRole('textbox', { name: 'Título da nota' });

    fireEvent.change(title, { target: { value: 'Salva ao trocar de nota' } });
    view.unmount();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[1]).toMatchObject({ title: 'Salva ao trocar de nota' });
  });
});

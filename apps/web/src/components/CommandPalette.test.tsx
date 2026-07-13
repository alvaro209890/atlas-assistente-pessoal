import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';

describe('CommandPalette', () => {
  it('navigates to every requested workspace surface', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open activeView="today" onClose={vi.fn()} onNavigate={onNavigate} onNewNote={vi.fn()} onToggleAi={vi.fn()} />);

    await user.type(screen.getByLabelText('Buscar comando'), 'cérebro');
    await user.click(screen.getByRole('option', { name: /Ir para Cérebro/i }));
    expect(onNavigate).toHaveBeenCalledWith('brain');
  });

  it('supports keyboard selection', async () => {
    const onNewNote = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open activeView="today" onClose={vi.fn()} onNavigate={vi.fn()} onNewNote={onNewNote} onToggleAi={vi.fn()} />);
    const search = screen.getByLabelText('Buscar comando');
    await user.type(search, 'nova nota');
    await user.keyboard('{Enter}');
    expect(onNewNote).toHaveBeenCalledOnce();
  });
});

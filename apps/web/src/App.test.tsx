import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App preview flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('keeps API errors visible and opens preview only on request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: 'API offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText(/API está indisponível/i)).toBeInTheDocument();
    expect(screen.queryByText(/Preview demonstrativo · os dados/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Explorar preview demonstrativo' }));
    expect(await screen.findByText(/Preview demonstrativo · os dados/i, {}, { timeout: 2500 })).toBeInTheDocument();
    expect(await screen.findByText('Bom dia, Marina', {}, { timeout: 2500 })).toBeInTheDocument();
  });

  it('opens the command palette with Ctrl+K', async () => {
    window.history.replaceState(null, '', '/?preview=demo');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Bom dia, Marina', {}, { timeout: 2500 });
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Paleta de comandos' })).toBeInTheDocument());
  });
});

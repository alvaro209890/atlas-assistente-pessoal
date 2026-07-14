import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../api';
import { demoOnboarding } from '../demo';
import type { AppEvent, OnboardingStatus } from '../types';
import { OnboardingFlow } from './OnboardingFlow';

describe('OnboardingFlow live updates', () => {
  it('uses SSE to refresh WhatsApp state while polling remains available', async () => {
    const api = createApi(true);
    const initial: OnboardingStatus = structuredClone(demoOnboarding);
    const connected: OnboardingStatus = {
      ...structuredClone(demoOnboarding),
      step: 2,
      whatsapp: {
        id: 'preview-whatsapp',
        status: 'connected',
        phoneLabel: '+55 11 99999-0000',
      },
    };
    api.getOnboarding = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(connected);
    let eventListener: ((event: AppEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    api.subscribeEvents = vi.fn((listener) => {
      eventListener = listener;
      return unsubscribe;
    });

    const view = render(<OnboardingFlow api={api} onComplete={vi.fn()} />);
    expect(await screen.findByText('Conecte seu WhatsApp para o Atlas ler')).toBeInTheDocument();

    act(() => eventListener?.({
      id: 7,
      topic: 'whatsapp',
      eventType: 'whatsapp.state.changed',
      payload: { status: 'connected' },
      createdAt: '2026-07-13T12:00:00.000Z',
    }));

    await waitFor(() => expect(api.getOnboarding).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(await screen.findByText('WhatsApp pessoal conectado somente para leitura')).toBeInTheDocument();
    expect(screen.getByText(/\+55 11 99999-0000 identificado automaticamente/)).toBeInTheDocument();

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('never renders the preview QR for a real connection error', async () => {
    const api = createApi(true);
    Object.defineProperty(api, 'isPreview', { value: false });
    const failedStatus: OnboardingStatus = {
      ...structuredClone(demoOnboarding),
      step: 2,
      whatsapp: {
        id: 'real-whatsapp',
        status: 'error',
        error: 'Sessão encerrada pelo WhatsApp.',
      },
    };
    api.getOnboarding = vi.fn(async () => failedStatus);

    render(<OnboardingFlow api={api} onComplete={vi.fn()} />);

    expect(await screen.findByText('Não foi possível conectar')).toBeInTheDocument();
    expect(screen.getByText('Sessão encerrada pelo WhatsApp.')).toBeInTheDocument();
    expect(screen.queryByLabelText('QR Code demonstrativo do preview')).not.toBeInTheDocument();
  });

  it('explains the Trello workflow immediately after authorization', async () => {
    const api = createApi(true);
    const setup = {
      ...structuredClone(demoOnboarding.trello!),
      connected: true,
      accountName: 'Marina Costa',
    };
    const connectedStatus: OnboardingStatus = {
      ...structuredClone(demoOnboarding),
      step: 3,
      trelloConnected: true,
      trello: setup,
    };
    api.getOnboarding = vi.fn(async () => connectedStatus);
    api.getTrelloSetup = vi.fn(async () => setup);

    render(<OnboardingFlow api={api} onComplete={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Como o Atlas usa o Trello' })).toBeInTheDocument();
    expect(screen.getByText('O quadro reúne seu trabalho, cada lista representa uma fase e cada cartão é uma tarefa.')).toBeInTheDocument();
    expect(screen.getByText('Sincronização em duas vias')).toBeInTheDocument();
    expect(screen.getByText(/Na próxima etapa você escolhe o quadro/)).toBeInTheDocument();
  });
});

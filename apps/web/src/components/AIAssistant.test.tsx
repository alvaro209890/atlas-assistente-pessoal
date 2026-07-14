import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../api';
import type { AiRequest } from '../types';
import { AIAssistant } from './AIAssistant';

describe('AIAssistant', () => {
  it('reuses the backend thread and opens note sources', async () => {
    const askAi = vi.fn(async (_input: AiRequest) => ({
      answer: 'Resposta contextual',
      threadId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
      sources: [{
        id: '44444444-4444-4444-8444-444444444444',
        title: 'Decisão importante',
        excerpt: 'Uma fonte interna.',
        kind: 'note' as const,
        updatedAt: 'agora',
      }],
    }));
    const onOpenNote = vi.fn();
    const api = { askAi, listChatThreads: async () => [], getChatMessages: async () => [] } as unknown as AppApi;
    const user = userEvent.setup();
    render(<AIAssistant api={api} view="today" noteId={null} mobileOpen={false} onMobileClose={() => undefined} onOpenNote={onOpenNote} />);

    const composer = screen.getByRole('textbox', { name: 'Mensagem para o Atlas' });
    await user.type(composer, 'Primeira pergunta');
    await user.click(screen.getByRole('button', { name: 'Enviar pergunta' }));
    await screen.findByText('Resposta contextual');

    await user.click(screen.getByRole('button', { name: 'Abrir nota Decisão importante' }));
    expect(onOpenNote).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444');

    await user.type(composer, 'Pergunta seguinte');
    await user.click(screen.getByRole('button', { name: 'Enviar pergunta' }));
    await waitFor(() => expect(askAi).toHaveBeenCalledTimes(2));
    expect(askAi.mock.calls[1]?.[0]).toMatchObject({
      message: 'Pergunta seguinte',
      threadId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('edits a proposal with an explicit patch before execution', async () => {
    const askAi = vi.fn(async () => ({
      answer: 'Posso reorganizar sua tarefa.',
      threadId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
      sources: [],
      proposals: [{
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Reagendar entrega',
        description: 'Mover a entrega para amanhã.',
        actionType: 'task.reschedule',
        risk: 'low' as const,
        reversible: true,
        status: 'pending' as const,
        evidence: [],
      }],
    }));
    const actOnProposal = vi.fn(async (_id: string, input: { action: string; patch?: Record<string, unknown> }) => ({
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Reagendar entrega',
      description: String(input.patch?.description),
      actionType: 'task.reschedule',
      risk: 'low' as const,
      reversible: true,
      status: input.action === 'confirm' ? 'confirmed' as const : 'edited' as const,
      evidence: [],
    }));
    const api = { askAi, actOnProposal, listChatThreads: async () => [], getChatMessages: async () => [] } as unknown as AppApi;
    const user = userEvent.setup();
    render(<AIAssistant api={api} view="today" noteId={null} mobileOpen={false} onMobileClose={() => undefined} onOpenNote={() => undefined} />);

    await user.type(screen.getByRole('textbox', { name: 'Mensagem para o Atlas' }), 'Organize isso');
    await user.click(screen.getByRole('button', { name: 'Enviar pergunta' }));
    await user.click(await screen.findByRole('button', { name: 'Editar' }));

    const editor = screen.getByLabelText('Descreva como a proposta deve ficar');
    await user.clear(editor);
    await user.type(editor, 'Mover a entrega para sexta às 14h.');
    await user.click(screen.getByRole('button', { name: 'Salvar alteração' }));

    await waitFor(() => expect(actOnProposal).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555',
      { action: 'edit', patch: { description: 'Mover a entrega para sexta às 14h.' } },
    ));
    await user.click(await screen.findByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(actOnProposal).toHaveBeenLastCalledWith(
      '55555555-5555-4555-8555-555555555555',
      { action: 'confirm' },
    ));
    expect(await screen.findByText('Proposta confirmada')).toBeInTheDocument();
  });

  it('requires a concrete date before a reminder proposal can be confirmed', async () => {
    const proposalId = '66666666-6666-4666-8666-666666666666';
    const askAi = vi.fn(async () => ({
      answer: 'Posso criar esse lembrete.',
      threadId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
      sources: [],
      proposals: [{
        id: proposalId,
        title: 'Lembrar de revisar o contrato',
        description: 'Escolha quando devo avisar.',
        actionType: 'create_reminder',
        risk: 'low' as const,
        reversible: true,
        status: 'pending' as const,
        evidence: [],
        payload: { needsScheduleResolution: true },
      }],
    }));
    const actOnProposal = vi.fn(async (_id: string, input: { action: string; patch?: Record<string, unknown> }) => ({
      id: proposalId,
      title: 'Lembrar de revisar o contrato',
      description: String(input.patch?.description),
      actionType: 'create_reminder',
      risk: 'low' as const,
      reversible: true,
      status: 'edited' as const,
      evidence: [],
      payload: input.patch,
    }));
    const api = { askAi, actOnProposal, listChatThreads: async () => [], getChatMessages: async () => [] } as unknown as AppApi;
    const user = userEvent.setup();
    render(<AIAssistant api={api} view="today" noteId={null} mobileOpen={false} onMobileClose={() => undefined} onOpenNote={() => undefined} />);

    await user.type(screen.getByRole('textbox', { name: 'Mensagem para o Atlas' }), 'Me lembre do contrato');
    await user.click(screen.getByRole('button', { name: 'Enviar pergunta' }));
    const confirm = await screen.findByRole('button', { name: 'Confirmar' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Editar' }));
    const when = screen.getByLabelText('Data e hora do lembrete');
    await user.type(when, '2026-07-14T09:00');
    await user.click(screen.getByRole('button', { name: 'Salvar alteração' }));

    await waitFor(() => expect(actOnProposal).toHaveBeenCalledWith(proposalId, {
      action: 'edit',
      patch: expect.objectContaining({
        scheduledFor: new Date('2026-07-14T09:00').toISOString(),
        needsScheduleResolution: false,
      }),
    }));
    expect(await screen.findByRole('button', { name: 'Confirmar' })).toBeEnabled();
  });
});

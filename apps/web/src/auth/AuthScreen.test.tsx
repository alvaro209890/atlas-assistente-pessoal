import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthScreen } from './AuthScreen';
import type { Session } from '../types';

const session: Session = {
  user: { id: 'user-1', preferredName: 'Marina', fullName: 'Marina Costa', email: 'marina@example.com' },
  onboardingComplete: false,
};

const renderAuth = (overrides: Partial<React.ComponentProps<typeof AuthScreen>> = {}) => {
  const props: React.ComponentProps<typeof AuthScreen> = {
    onLogin: vi.fn().mockResolvedValue(session),
    onRegister: vi.fn().mockResolvedValue(session),
    onAuthenticated: vi.fn(),
    onPreview: vi.fn(),
    ...overrides,
  };
  return { ...render(<AuthScreen {...props} />), props };
};

describe('AuthScreen', () => {
  it('submits login credentials through the real auth handler', async () => {
    const user = userEvent.setup();
    const { props } = renderAuth();
    await user.type(screen.getByLabelText('E-mail'), 'marina@example.com');
    await user.type(screen.getByLabelText('Senha'), 'senhasegura10');
    await user.click(screen.getByRole('button', { name: 'Entrar no Atlas' }));

    expect(props.onLogin).toHaveBeenCalledWith({ email: 'marina@example.com', password: 'senhasegura10' });
    expect(props.onAuthenticated).toHaveBeenCalledWith(session);
  });

  it('requires a ten-character password and exposes no fake recovery action', async () => {
    const user = userEvent.setup();
    renderAuth();
    await user.click(screen.getByRole('tab', { name: 'Criar conta' }));
    const password = screen.getByLabelText('Senha');
    expect(password).toHaveAttribute('minlength', '10');
    expect(screen.queryByRole('button', { name: /esqueci/i })).not.toBeInTheDocument();
  });

  it('requires a preferred name and sends the optional full name on registration', async () => {
    const user = userEvent.setup();
    const { props } = renderAuth();
    await user.click(screen.getByRole('tab', { name: 'Criar conta' }));
    await user.type(screen.getByLabelText('Como Atlas deve chamar você?'), 'Bia');
    await user.type(screen.getByLabelText(/Nome completo/), 'Beatriz Nunes');
    await user.type(screen.getByLabelText('E-mail'), 'bia@example.com');
    await user.type(screen.getByLabelText('Senha'), 'senhasegura10');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Criar minha conta' }));
    expect(props.onRegister).toHaveBeenCalledWith({ preferredName: 'Bia', fullName: 'Beatriz Nunes', email: 'bia@example.com', password: 'senhasegura10' });
  });

  it('enters demo mode only after an explicit preview action', async () => {
    const onPreview = vi.fn();
    const user = userEvent.setup();
    renderAuth({ onPreview });
    await user.click(screen.getByRole('button', { name: 'Explorar preview demonstrativo' }));
    expect(onPreview).toHaveBeenCalledOnce();
  });
});

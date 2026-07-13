import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail, Sparkles } from 'lucide-react';
import type { AuthInput, Session } from '../types';
import { ApiError } from '../api';
import { Brand, Spinner } from '../components/ui';

interface AuthScreenProps {
  onLogin(input: AuthInput): Promise<Session>;
  onRegister(input: AuthInput): Promise<Session>;
  onAuthenticated(session: Session): void;
  onPreview(): void;
  serviceError?: string | null;
}

export function AuthScreen({ onLogin, onRegister, onAuthenticated, onPreview, serviceError }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [preferredName, setPreferredName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'register' && !acceptedTerms) {
      setError('Confirme os termos para criar sua conta.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        email: email.trim(),
        password,
        ...(mode === 'register' ? { preferredName: preferredName.trim(), ...(fullName.trim() ? { fullName: fullName.trim() } : {}) } : {}),
      };
      const session = mode === 'login' ? await onLogin(input) : await onRegister(input);
      onAuthenticated(session);
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : 'Não foi possível entrar. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="Conheça o Atlas">
        <div className="auth-story__top"><Brand /></div>
        <div className="auth-story__content">
          <span className="eyebrow"><Sparkles size={14} /> Contexto, não ruído</span>
          <h1>Suas conversas viram <em>clareza.</em></h1>
          <p>Atlas conecta mensagens, tarefas e ideias para que você sempre encontre o próximo passo.</p>
          <div className="auth-proof">
            <span><Check size={14} /> WhatsApp conectado com segurança</span>
            <span><Check size={14} /> Trello organizado no seu contexto</span>
            <span><Check size={14} /> Respostas com fontes verificáveis</span>
          </div>
        </div>
        <div className="auth-story__artifact" aria-hidden="true">
          <div className="artifact-note artifact-note--one"><span>Decisão</span><strong>Lançamento quinta</strong></div>
          <div className="artifact-line" />
          <div className="artifact-node"><span>A</span></div>
          <div className="artifact-line artifact-line--two" />
          <div className="artifact-note artifact-note--two"><span>Próxima ação</span><strong>Revisar apresentação</strong></div>
        </div>
        <small className="auth-story__foot">Privado por padrão. Seu contexto pertence a você.</small>
      </section>

      <section className="auth-panel">
        <div className="auth-panel__mobile-brand"><Brand /></div>
        <div className="auth-card">
          <div className="auth-card__heading">
            <span className="eyebrow">{mode === 'login' ? 'Bem-vindo de volta' : 'Conheça seu Atlas'}</span>
            <h2>{mode === 'login' ? 'Entre na sua conta' : 'Crie sua conta'}</h2>
            <p>{mode === 'login' ? 'Seu segundo cérebro está esperando.' : 'Leva menos de dois minutos para começar.'}</p>
          </div>

          <div className="auth-tabs" role="tablist" aria-label="Acesso">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => changeMode('login')}>Entrar</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-active' : ''} onClick={() => changeMode('register')}>Criar conta</button>
          </div>

          {serviceError && <div className="inline-notice inline-notice--warning">A API está indisponível agora. Você ainda pode abrir o preview demonstrativo.</div>}
          {error && <div className="form-error" role="alert">{error}</div>}

          <form className="auth-form" onSubmit={submit}>
            {mode === 'register' && (
              <label>
                <span>Como Atlas deve chamar você?</span>
                <div className="field-shell"><Sparkles size={17} /><input autoComplete="nickname" value={preferredName} onChange={(event) => setPreferredName(event.target.value)} placeholder="Seu nome preferido" required /></div>
              </label>
            )}
            {mode === 'register' && (
              <label>
                <span>Nome completo <small className="optional-label">opcional</small></span>
                <div className="field-shell"><Sparkles size={17} /><input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Como aparece nos seus documentos" /></div>
              </label>
            )}
            <label>
              <span>E-mail</span>
              <div className="field-shell"><Mail size={17} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@empresa.com" required /></div>
            </label>
            <label>
              <span>Senha</span>
              <div className="field-shell"><LockKeyhole size={17} /><input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mínimo de 10 caracteres" required /><button className="field-icon-button" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
            </label>

            {mode === 'register' ? (
              <label className="checkbox-row"><input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} /><span>Concordo com os Termos de uso e a Política de privacidade.</span></label>
            ) : (
              <span className="auth-forgot auth-forgot--disabled">Recuperação de senha disponível em breve</span>
            )}

            <button className="button button--primary button--wide" type="submit" disabled={submitting}>
              {submitting ? <Spinner label={mode === 'login' ? 'Entrando' : 'Criando conta'} /> : <>{mode === 'login' ? 'Entrar no Atlas' : 'Criar minha conta'} <ArrowRight size={17} /></>}
            </button>
          </form>

          <div className="auth-divider"><span>ou</span></div>
          <button className="button button--ghost button--wide" type="button" onClick={onPreview}>Explorar preview demonstrativo</button>
          <p className="preview-disclaimer">O preview usa dados fictícios e não conecta nenhuma conta.</p>
        </div>
      </section>
    </main>
  );
}

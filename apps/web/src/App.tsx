import { useEffect, useMemo, useState } from 'react';
import { createApi } from './api';
import type { AuthInput, Session } from './types';
import { AuthScreen } from './auth/AuthScreen';
import { LoadingScreen } from './components/ui';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { Workspace } from './workspace/Workspace';

const previewFromUrl = () => new URLSearchParams(window.location.search).get('preview') === 'demo';

export function App() {
  const [preview, setPreview] = useState(previewFromUrl);
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const api = useMemo(() => createApi(preview), [preview]);

  useEffect(() => {
    let active = true;
    setBooting(true);
    setServiceError(null);
    api
      .getSession()
      .then((next) => {
        if (active) setSession(next);
      })
      .catch((error) => {
        if (!active) return;
        setSession(null);
        setServiceError(error instanceof Error ? error.message : 'A API do Atlas não respondeu.');
      })
      .finally(() => active && setBooting(false));
    return () => { active = false; };
  }, [api]);

  const enterPreview = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('preview', 'demo');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setPreview(true);
  };

  const exitPreview = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('preview');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    setSession(null);
    setPreview(false);
  };

  const login = (input: AuthInput) => api.login(input);
  const register = (input: AuthInput) => api.register(input);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      if (preview) exitPreview();
      else setSession(null);
    }
  };

  if (booting) return <LoadingScreen />;

  if (!session) {
    return (
      <AuthScreen
        onLogin={login}
        onRegister={register}
        onAuthenticated={setSession}
        onPreview={enterPreview}
        serviceError={serviceError}
      />
    );
  }

  if (!session.onboardingComplete) {
    return <OnboardingFlow api={api} onComplete={setSession} onExitPreview={preview ? exitPreview : undefined} />;
  }

  return <Workspace api={api} session={session} onLogout={logout} onEnterPreview={enterPreview} onExitPreview={exitPreview} />;
}

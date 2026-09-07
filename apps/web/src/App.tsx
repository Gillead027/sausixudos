import { lazy, Suspense, useEffect, useState } from 'react';
import type { PublicConfig, UserSession } from '@sausixudos/shared';
import { api } from './api';
import { EntryScreen } from './components/EntryScreen';

const Workspace = lazy(() =>
  import('./components/Workspace').then((module) => ({ default: module.Workspace })),
);

type BootState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'ready'; session: UserSession; config: PublicConfig }
  | { status: 'error'; message: string };

function LoadingWindow({ label }: { label: string }) {
  return (
    <main className="splash" aria-live="polite">
      <div className="boot-window">
        <div className="boot-title">Sausixudos</div>
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <span>{label}</span>
      </div>
    </main>
  );
}

export function App() {
  const [state, setState] = useState<BootState>({ status: 'loading' });

  async function loadAuthenticatedApp(session: UserSession) {
    try {
      const config = await api.getConfig();
      setState({ status: 'ready', session, config });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Não foi possível carregar o aplicativo.',
      });
    }
  }

  useEffect(() => {
    let active = true;
    api
      .getSession()
      .then(({ user }) => {
        if (active) void loadAuthenticatedApp(user);
      })
      .catch(() => {
        if (active) setState({ status: 'signed-out' });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') return <LoadingWindow label="Carregando usuário…" />;
  if (state.status === 'signed-out') return <EntryScreen onAuthenticated={loadAuthenticatedApp} />;

  if (state.status === 'error') {
    return (
      <main className="splash error-page">
        <h1>Não foi possível iniciar</h1>
        <p>{state.message}</p>
        <button className="primary-button" onClick={() => window.location.reload()}>
          Tentar novamente
        </button>
      </main>
    );
  }

  return (
    <Suspense fallback={<LoadingWindow label="Carregando interface…" />}>
      <Workspace
        session={state.session}
        config={state.config}
        onSignOut={async () => {
          await api.deleteSession().catch(() => undefined);
          setState({ status: 'signed-out' });
        }}
        onProfileUpdated={(session) =>
          setState((current) => (current.status === 'ready' ? { ...current, session } : current))
        }
      />
    </Suspense>
  );
}

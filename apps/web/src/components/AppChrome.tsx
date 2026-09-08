import type { ReactNode } from 'react';

export function AppChrome() {
  return (
    <header className="app-chrome">
      <div className="app-chrome-brand">
        <span className="brand-mark" aria-hidden="true"><i /><i /></span>
        <strong>Sausixudos</strong>
        <span className="beta-badge">BETA</span>
      </div>
      <div className="app-chrome-drag" />
      {typeof window !== 'undefined' && window.desktop?.windowAction && (
        <div className="window-controls" aria-label="Controles da janela">
          <button type="button" onClick={() => window.desktop?.windowAction?.('minimize')} aria-label="Minimizar">—</button>
          <button type="button" onClick={() => window.desktop?.windowAction?.('toggle-maximize')} aria-label="Maximizar">□</button>
          <button type="button" className="window-close" onClick={() => window.desktop?.windowAction?.('close')} aria-label="Fechar">×</button>
        </div>
      )}
    </header>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  return <div className="app-frame"><AppChrome />{children}</div>;
}

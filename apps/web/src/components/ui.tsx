import type { ReactNode } from 'react';
import { AlertCircle, Inbox, LoaderCircle, RotateCcw } from 'lucide-react';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="Atlas">
      <span className="brand-mark" aria-hidden="true"><span>A</span></span>
      {!compact && (
        <span className="brand-copy">
          <strong>Atlas</strong>
          <small>seu segundo cérebro</small>
        </span>
      )}
    </div>
  );
}

export function Spinner({ label = 'Carregando' }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <LoaderCircle size={17} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">{icon || <Inbox size={22} />}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Algo não saiu como esperado',
  message,
  onRetry,
  extra,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="error-state" role="alert">
      <span className="error-state__icon"><AlertCircle size={21} /></span>
      <div>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="error-state__actions">
          {onRetry && (
            <button className="button button--secondary button--small" type="button" onClick={onRetry}>
              <RotateCcw size={14} /> Tentar novamente
            </button>
          )}
          {extra}
        </div>
      </div>
    </div>
  );
}

export function Avatar({ name, size = 'medium' }: { name: string; size?: 'small' | 'medium' | 'large' }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return <span className={`avatar avatar--${size}`} aria-label={name}>{initials}</span>;
}

export function LoadingScreen({ label = 'Preparando seu espaço' }: { label?: string }) {
  return (
    <main className="loading-screen">
      <Brand />
      <div className="loading-orbit" aria-hidden="true"><span /></div>
      <p>{label}</p>
    </main>
  );
}

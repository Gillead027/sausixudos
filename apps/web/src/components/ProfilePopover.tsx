import { useEffect, useRef, useState } from 'react';
import { ACCENT_COLORS, type UserSession } from '@sausixudos/shared';
import { api } from '../api';
import { Avatar } from './Workspace';
import { CloseIcon } from './Icons';

export interface ProfilePopoverTarget {
  userId: string;
  rect: DOMRect;
}

const remoteProfileCache = new Map<string, UserSession | null>();

function useUserProfile(userId: string, ownSession: UserSession): UserSession | null | undefined {
  const isOwn = userId === ownSession.id;
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (isOwn || remoteProfileCache.has(userId)) return;
    let active = true;
    void api
      .getUserProfile(userId)
      .then(({ user }) => {
        if (!active) return;
        remoteProfileCache.set(userId, user);
        forceRender((value) => value + 1);
      })
      .catch(() => {
        if (active) remoteProfileCache.set(userId, null);
        if (active) forceRender((value) => value + 1);
      });
    return () => {
      active = false;
    };
  }, [isOwn, userId]);

  if (isOwn) return ownSession;
  return remoteProfileCache.get(userId);
}

const POPOVER_WIDTH = 300;
const POPOVER_MARGIN = 12;

function clampPosition(rect: DOMRect): { top: number; left: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  let left = rect.left;
  if (left + POPOVER_WIDTH + POPOVER_MARGIN > viewportWidth) {
    left = Math.max(POPOVER_MARGIN, viewportWidth - POPOVER_WIDTH - POPOVER_MARGIN);
  }
  // Tenta abrir abaixo do elemento clicado; se não couber, abre acima dele.
  const estimatedHeight = 260;
  let top = rect.bottom + 8;
  if (top + estimatedHeight > viewportHeight) {
    top = Math.max(POPOVER_MARGIN, rect.top - estimatedHeight - 8);
  }
  return { top, left };
}

export function ProfilePopover({
  target,
  ownSession,
  onClose,
}: {
  target: ProfilePopoverTarget | null;
  ownSession: UserSession;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const userId = target?.userId ?? '';
  const profile = useUserProfile(userId, ownSession);

  useEffect(() => {
    if (!target) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [target, onClose]);

  if (!target) return null;

  const { top, left } = clampPosition(target.rect);

  return (
    <div className="profile-popover" ref={popoverRef} role="dialog" aria-label="Perfil do usuário" style={{ top: `${top}px`, left: `${left}px` }}>
      <button type="button" className="profile-popover-close" onClick={onClose} aria-label="Fechar">
        <CloseIcon size={13} />
      </button>
      {profile === undefined ? (
        <div className="profile-popover-loading">Carregando perfil…</div>
      ) : profile === null ? (
        <div className="profile-popover-loading">Não foi possível carregar esse perfil.</div>
      ) : (
        <div className="profile-preview">
          {profile.bannerUrl ? (
            <img className="profile-preview-banner has-image" src={profile.bannerUrl} alt="" />
          ) : (
            <div className={`profile-preview-banner avatar-color-${ACCENT_COLORS.indexOf(profile.accentColor)}`} />
          )}
          <Avatar name={profile.displayName} accentColor={profile.accentColor} avatarUrl={profile.avatarUrl} />
          <strong>{profile.displayName}</strong>
          {profile.pronouns && <em>{profile.pronouns}</em>}
          {profile.statusText && <span>{profile.statusText}</span>}
          {profile.bio && <p>{profile.bio}</p>}
        </div>
      )}
    </div>
  );
}

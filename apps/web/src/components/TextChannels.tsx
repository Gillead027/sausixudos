import { type FormEvent, type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH,
  TEXT_CHANNEL_NAME_MAX_LENGTH,
  type TextChannel,
  type TextMessage,
  type UserSession,
} from '@sausixudos/shared';
import { api } from '../api';
import { routeTextChannelInput } from '../musicCommandRouting';
import { CloseIcon, MessageIcon, SearchIcon, VoiceIcon } from './Icons';

type MessageStyle = 'default' | 'compact' | 'grouped';

const textAvatarCache = new Map<string, string>();

function useTextAvatar(userId: string, session: UserSession): string | undefined {
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (userId === session.id || textAvatarCache.has(userId)) return;
    let active = true;
    void api.getUserAvatar(userId).then(({ avatarUrl }) => {
      if (!active) return;
      textAvatarCache.set(userId, avatarUrl);
      forceRender((value) => value + 1);
    }).catch(() => {
      if (active) textAvatarCache.set(userId, '');
    });
    return () => {
      active = false;
    };
  }, [session.id, userId]);
  return userId === session.id ? session.avatarUrl || undefined : textAvatarCache.get(userId) || undefined;
}

function TextMessageRow({
  message,
  continued,
  session,
  onOpenProfile,
}: {
  message: TextMessage;
  continued: boolean;
  session: UserSession;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
}) {
  const avatarUrl = useTextAvatar(message.senderId, session);
  const initial = message.senderName.trim().charAt(0).toUpperCase() || '?';
  return (
    <article className={`message text-message ${continued ? 'continued' : ''}`}>
      <button
        type="button"
        className="message-avatar-trigger"
        onClick={(event) => onOpenProfile(message.senderId, event)}
        title={`Ver perfil de ${message.senderName}`}
      >
        <span className="text-message-avatar" aria-hidden="true">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : initial}
        </span>
      </button>
      <div>
        <header>
          <button type="button" className="message-name-trigger" onClick={(event) => onOpenProfile(message.senderId, event)}>
            {message.senderName}
          </button>
          <time dateTime={new Date(message.sentAt).toISOString()}>
            {new Date(message.sentAt).toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </header>
        <p>{message.text}</p>
      </div>
    </article>
  );
}

export function TextChannelView({
  channel,
  session,
  messageStyle,
  voiceChannelId,
  onOpenProfile,
}: {
  channel: TextChannel;
  session: UserSession;
  messageStyle: MessageStyle;
  voiceChannelId: string | null;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
}) {
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    let requestRunning = false;
    setMessages([]);
    setDraft('');
    setLoading(true);
    setError('');
    setFeedback('');

    const refresh = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const result = await api.getTextMessages(channel.id);
        if (active) {
          setMessages(result.messages);
          setError('');
        }
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar as mensagens.');
        }
      } finally {
        requestRunning = false;
        if (active) setLoading(false);
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [channel.id]);

  useEffect(() => {
    if (!loading) endRef.current?.scrollIntoView({ block: 'end' });
  }, [channel.id, loading]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    setFeedback('');
    try {
      const result = await routeTextChannelInput({
        text,
        voiceChannelId,
        sendMusicCommand: api.sendMusicCommand,
        sendTextMessage: async (messageText) => (await api.sendTextMessage(channel.id, messageText)).message,
      });
      if (result.kind === 'text-message') {
        const { message } = result;
        setMessages((current) => current.some(({ id }) => id === message.id) ? current : [...current, message]);
        window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      } else {
        setFeedback(result.response.message);
      }
      setDraft('');
      inputRef.current?.focus();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="text-channel-view" aria-label={`Canal de texto ${channel.name}`}>
      {error && <div className="error-banner" role="alert"><span>{error}</span></div>}
      {feedback && <div className="audio-permission" role="status"><span>{feedback}</span></div>}
      <div
        className={`messages text-channel-messages ${messageStyle === 'compact' ? 'compact' : ''} ${messageStyle === 'grouped' ? 'grouped' : ''}`}
        role="log"
        aria-live="polite"
        aria-busy={loading}
        aria-relevant="additions text"
      >
        {loading ? (
          <div className="empty-chat"><strong>Carregando mensagens…</strong></div>
        ) : messages.length === 0 ? (
          <div className="text-channel-welcome">
            <span aria-hidden="true">#</span>
            <h2>Boas-vindas a #{channel.name}</h2>
            <p>Este é o começo deste canal. Envie a primeira mensagem.</p>
          </div>
        ) : messages.map((message, index) => {
          const previous = messages[index - 1];
          const continued =
            messageStyle === 'grouped' &&
            previous?.senderId === message.senderId &&
            message.sentAt - previous.sentAt < 5 * 60 * 1000;
          return (
            <TextMessageRow
              key={message.id}
              message={message}
              continued={continued}
              session={session}
              onOpenProfile={onOpenProfile}
            />
          );
        })}
        <div ref={endRef} />
      </div>
      <form className="text-channel-form" onSubmit={submitMessage}>
        <label className="sr-only" htmlFor="text-channel-message">Mensagem para #{channel.name}</label>
        <textarea
          ref={inputRef}
          id="text-channel-message"
          rows={1}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={`Conversar em #${channel.name}`}
        />
        <div className="text-channel-form-meta">
          <span>{draft.length}/{CHAT_MESSAGE_MAX_LENGTH}</span>
          <button type="submit" disabled={sending || !draft.trim()}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function CreateTextChannelDialog({
  open,
  onClose,
  onCreated,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (channel: TextChannel) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const close = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (!open) return;
    nameInputRef.current?.focus();
    const overlay = overlayRef.current;
    const backgroundSiblings = Array.from(overlay?.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      .map((element) => ({ element, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const { element } of backgroundSiblings) {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      for (const { element, ariaHidden } of backgroundSiblings) {
        element.removeAttribute('inert');
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
    };
  }, [close, open, saving]);

  if (!open) return null;

  async function submitChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const { channel } = await api.createTextChannel(name, description);
      setName('');
      setDescription('');
      onCreated(channel);
      close();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível criar o canal.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={overlayRef} className="dialog-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) close();
    }}>
      <form
        ref={dialogRef}
        className="channel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={submitChannel}
      >
        <header>
          <div>
            <h2 id={titleId}>Criar canal</h2>
            <p id={descriptionId}>Configure o novo espaço do seu servidor.</p>
          </div>
          <button type="button" onClick={close} disabled={saving} aria-label="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>
        <label>Tipo de canal</label>
        <div className="channel-type-grid" aria-label="Tipo de canal">
          <button type="button" className="channel-type-card selected">
            <MessageIcon size={21} /><span><strong>Texto</strong><small>Envie mensagens, imagens e arquivos</small></span><i>✓</i>
          </button>
          <button type="button" className="channel-type-card">
            <VoiceIcon size={21} /><span><strong>Voz</strong><small>Converse por voz e vídeo</small></span>
          </button>
          <button type="button" className="channel-type-card">
            <span className="forum-glyph">▤</span><span><strong>Fórum</strong><small>Discussões organizadas por tópicos</small></span>
          </button>
        </div>
        <label htmlFor="channel-name">Nome do canal</label>
        <div className="channel-name-field">
          <span aria-hidden="true">#</span>
          <input
            ref={nameInputRef}
            id="channel-name"
            maxLength={TEXT_CHANNEL_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="novo-canal"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            required
          />
        </div>
        <label htmlFor="channel-description">Descrição <span>(opcional)</span></label>
        <input
          id="channel-description"
          maxLength={TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Sobre o que é este canal?"
        />
        <div className="channel-static-option">
          <div><strong>Canal privado</strong><span>Somente membros e cargos selecionados poderão acessar.</span></div>
          <button type="button" className="settings-switch" aria-label="Canal privado" />
        </div>
        <label>Quem pode acessar?</label>
        <div className="channel-access-search"><SearchIcon size={15} /><input readOnly placeholder="Buscar cargos ou membros" /></div>
        <div className="channel-access-list">
          <div><span className="access-avatar everyone">@</span><p><strong>@everyone</strong><small>Todos os membros do servidor</small></p><i>✓</i></div>
          <div><span className="access-avatar friends">A</span><p><strong>Amigo</strong><small>7 membros</small></p><i>✓</i></div>
        </div>
        {error && <p id={errorId} className="form-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="dialog-cancel" onClick={close} disabled={saving}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={saving || !name.trim()}>
            {saving ? 'Criando…' : 'Criar canal'}
          </button>
        </footer>
      </form>
    </div>
  );
}

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { CHAT_MESSAGE_MAX_LENGTH, type DmChannel, type DmMessage, type UserSession } from '@sausixudos/shared';
import { api } from '../api';
import { onRealtimeConnect, onRealtimeEvent } from '../realtime';
import { MarkdownText } from './Markdown';
import { Avatar } from './Workspace';
import { CopyIcon, EditIcon, TrashIcon } from './Icons';

// Mesma ideia de applyIncomingMessage em TextChannels.tsx, só que essa cópia
// pequena é deliberada (ver plano) — DM não precisa de reação/pin/anexo, e
// esse arquivo não exporta seus utilitários internos.
function applyIncomingMessage(current: DmMessage[], incoming: DmMessage): DmMessage[] {
  const index = current.findIndex(({ id }) => id === incoming.id);
  const next = index < 0 ? [...current, incoming] : current.map((message, position) => (position === index ? incoming : message));
  return next.sort((left, right) => left.sentAt - right.sentAt);
}

function DmMessageEditForm({
  initialText,
  onSave,
  onCancel,
}: {
  initialText: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  async function save() {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSave(trimmed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="message-edit-form">
      <textarea
        ref={textareaRef}
        rows={1}
        maxLength={CHAT_MESSAGE_MAX_LENGTH}
        value={text}
        disabled={saving}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="message-edit-hint">escape para cancelar · enter para salvar</div>
    </div>
  );
}

export function DmChannelView({
  channel,
  session,
  isBlockedByMe,
  onOpenProfile,
}: {
  channel: DmChannel;
  session: UserSession;
  isBlockedByMe: boolean;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
}) {
  const other = channel.participants.find((participant) => participant.id !== session.id) ?? channel.participants[0]!;
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isTimedOut = Boolean(session.timeoutUntil && session.timeoutUntil > Date.now());

  useEffect(() => {
    let active = true;
    setMessages([]);
    setDraft('');
    setLoading(true);
    setError('');
    setEditingMessageId(null);

    const refresh = async () => {
      try {
        const result = await api.getDmMessages(channel.id);
        if (active) setMessages(result.messages);
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar as mensagens.');
      } finally {
        if (active) setLoading(false);
      }
    };

    void refresh();
    const unsubscribeReconnect = onRealtimeConnect(() => void refresh());
    return () => {
      active = false;
      unsubscribeReconnect();
    };
  }, [channel.id]);

  useEffect(() => {
    return onRealtimeEvent((event) => {
      if (event.type === 'DM_MESSAGE_CREATE' || event.type === 'DM_MESSAGE_UPSERT') {
        if (event.dmChannelId !== channel.id) return;
        setMessages((current) => applyIncomingMessage(current, event.message));
        window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      } else if (event.type === 'DM_MESSAGE_DELETE') {
        if (event.dmChannelId !== channel.id) return;
        setMessages((current) => current.filter(({ id }) => id !== event.messageId));
      }
    });
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
    try {
      const { message } = await api.sendDmMessage(channel.id, text);
      setMessages((current) => applyIncomingMessage(current, message));
      setDraft('');
      inputRef.current?.focus();
      window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSending(false);
    }
  }

  async function saveEdit(messageId: string, text: string) {
    try {
      const { message } = await api.editDmMessage(channel.id, messageId, text);
      setMessages((current) => applyIncomingMessage(current, message));
      setEditingMessageId(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível editar a mensagem.');
    }
  }

  async function deleteMessage(messageId: string) {
    if (!window.confirm('Apagar esta mensagem? Essa ação não pode ser desfeita.')) return;
    try {
      await api.deleteDmMessage(channel.id, messageId);
      setMessages((current) => current.filter(({ id }) => id !== messageId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível apagar a mensagem.');
    }
  }

  const composerDisabled = isTimedOut || isBlockedByMe;

  return (
    <section className="text-channel-view dm-channel-view" aria-label={`Conversa com ${other.displayName}`}>
      <header className="room-header dm-channel-header">
        <button type="button" className="dm-header-identity" onClick={(event) => onOpenProfile(other.id, event)}>
          <Avatar name={other.displayName} accentColor={other.accentColor} avatarUrl={other.avatarUrl} />
          <strong>{other.displayName}</strong>
        </button>
      </header>
      {error && <div className="error-banner" role="alert"><span>{error}</span></div>}
      <div className="messages text-channel-messages" role="log" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="empty-chat"><strong>Carregando mensagens…</strong></div>
        ) : messages.length === 0 ? (
          <div className="text-channel-welcome">
            <span aria-hidden="true">@</span>
            <h2>Essa é a conversa com {other.displayName}</h2>
            <p>Diga oi!</p>
          </div>
        ) : (
          messages.map((message) => {
            const sender = channel.participants.find((participant) => participant.id === message.senderId) ?? other;
            const isOwn = message.senderId === session.id;
            return (
              <article className="message text-message" key={message.id}>
                <button type="button" className="message-avatar-trigger" onClick={(event) => onOpenProfile(sender.id, event)}>
                  <Avatar name={sender.displayName} accentColor={sender.accentColor} avatarUrl={sender.avatarUrl} compact />
                </button>
                <div>
                  <header>
                    <button type="button" className="message-name-trigger" onClick={(event) => onOpenProfile(sender.id, event)}>
                      {sender.displayName}
                    </button>
                    <time dateTime={new Date(message.sentAt).toISOString()}>
                      {new Date(message.sentAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </time>
                    {message.editedAt && <span className="message-edited-mark" title="Mensagem editada">(editado)</span>}
                  </header>
                  {editingMessageId === message.id ? (
                    <DmMessageEditForm initialText={message.text} onSave={(text) => saveEdit(message.id, text)} onCancel={() => setEditingMessageId(null)} />
                  ) : (
                    <p><MarkdownText text={message.text} /></p>
                  )}
                </div>
                <div className="message-hover-actions" role="toolbar" aria-label="Ações da mensagem">
                  <button type="button" title="Copiar texto" aria-label="Copiar texto" onClick={() => void navigator.clipboard.writeText(message.text)}>
                    <CopyIcon size={14} />
                  </button>
                  {isOwn && (
                    <>
                      <button type="button" title="Editar mensagem" aria-label="Editar mensagem" onClick={() => setEditingMessageId(message.id)}>
                        <EditIcon size={14} />
                      </button>
                      <button type="button" title="Apagar mensagem" aria-label="Apagar mensagem" onClick={() => void deleteMessage(message.id)}>
                        <TrashIcon size={14} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })
        )}
        <div ref={endRef} />
      </div>
      {isBlockedByMe && (
        <div className="reply-composer-banner timeout-composer-banner">
          <span>Você bloqueou {other.displayName} — desbloqueie pra continuar a conversa.</span>
        </div>
      )}
      {isTimedOut && session.timeoutUntil && !isBlockedByMe && (
        <div className="reply-composer-banner timeout-composer-banner">
          <span>
            Você está em timeout e não pode enviar mensagens até{' '}
            {new Date(session.timeoutUntil).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.
          </span>
        </div>
      )}
      <form className="text-channel-form" onSubmit={submitMessage}>
        <label className="sr-only" htmlFor="dm-message">Mensagem para {other.displayName}</label>
        <textarea
          ref={inputRef}
          id="dm-message"
          rows={1}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          value={draft}
          disabled={composerDisabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={composerDisabled ? '' : `Conversar com ${other.displayName}`}
        />
        <div className="text-channel-form-meta">
          <span>{draft.length}/{CHAT_MESSAGE_MAX_LENGTH}</span>
          <button type="submit" disabled={composerDisabled || sending || !draft.trim()}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </form>
    </section>
  );
}

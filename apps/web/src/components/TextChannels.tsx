import { type FormEvent, type RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  REACTION_EMOJI,
  TEXT_CHANNEL_DESCRIPTION_MAX_LENGTH,
  TEXT_CHANNEL_NAME_MAX_LENGTH,
  type MusicCommandResponse,
  type ReactionEmoji,
  type TextChannel,
  type TextMessage,
  type UserSession,
} from '@sausixudos/shared';
import { api } from '../api';
import { routeTextChannelInput } from '../musicCommandRouting';
import { onRealtimeConnect, onRealtimeEvent } from '../realtime';
import { MarkdownText } from './Markdown';
import { MusicCard } from './MusicCard';
import { CloseIcon, CopyIcon, EditIcon, MessageIcon, ReplyIcon, SearchIcon, SmileIcon, TrashIcon, VoiceIcon } from './Icons';

type MessageStyle = 'default' | 'compact' | 'grouped';

// Único ponto de mescla de uma mensagem nova/atualizada no array local —
// usado tanto pelo caminho otimista local (envio próprio) quanto pelos
// eventos de WebSocket, pra não duplicar a invariante "no máximo um card do
// bot por canal, substituído em vez de duplicado" em três lugares como
// antes. Reordena por sentAt porque eventos de WebSocket não têm garantia
// de ordem estrita entre reconexões.
function applyIncomingMessage(current: TextMessage[], incoming: TextMessage): TextMessage[] {
  const index = current.findIndex(({ id }) => id === incoming.id);
  const next = index < 0 ? [...current, incoming] : current.map((message, position) => (position === index ? incoming : message));
  return next.sort((left, right) => left.sentAt - right.sentAt);
}

// Aplica um add/remove de reação vindo do WebSocket direto no array local,
// sem precisar buscar a mensagem inteira de novo — os grupos por emoji só
// existem enquanto tiverem pelo menos um usuário.
function applyReactionChange(
  current: TextMessage[],
  messageId: string,
  emoji: ReactionEmoji,
  userId: string,
  action: 'add' | 'remove',
): TextMessage[] {
  return current.map((message) => {
    if (message.id !== messageId) return message;
    const groups = message.reactions ?? [];
    const index = groups.findIndex((group) => group.emoji === emoji);

    if (action === 'add') {
      if (index < 0) return { ...message, reactions: [...groups, { emoji, userIds: [userId] }] };
      if (groups[index]!.userIds.includes(userId)) return message;
      const nextGroups = groups.map((group, position) =>
        position === index ? { ...group, userIds: [...group.userIds, userId] } : group,
      );
      return { ...message, reactions: nextGroups };
    }

    if (index < 0) return message;
    const remainingUserIds = groups[index]!.userIds.filter((id) => id !== userId);
    const nextGroups = remainingUserIds.length
      ? groups.map((group, position) => (position === index ? { ...group, userIds: remainingUserIds } : group))
      : groups.filter((_, position) => position !== index);
    const { reactions: _droppedReactions, ...rest } = message;
    return nextGroups.length ? { ...rest, reactions: nextGroups } : rest;
  });
}

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

function BotTextMessageRow({
  message,
  onMusicCommand,
}: {
  message: TextMessage;
  onMusicCommand: (command: string) => Promise<MusicCommandResponse>;
}) {
  return (
    <article className="message text-message sausimusic-message">
      <div className="sausimusic-bot-avatar" aria-hidden="true"><span className="sausimusic-avatar-bars"><i /><i /><i /></span></div>
      <div className="sausimusic-message-content">
        <header className="sausimusic-message-header">
          <strong>{message.senderName}</strong>
          <span className="sausimusic-app-badge">APP</span>
          <time dateTime={new Date(message.sentAt).toISOString()}>
            {new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </time>
          <span className="sausimusic-sleep-mark" aria-hidden="true">zZ</span>
        </header>
        {message.musicCard ? (
          <MusicCard card={message.musicCard} onCommand={onMusicCommand} />
        ) : (
          <p><MarkdownText text={message.text} /></p>
        )}
      </div>
    </article>
  );
}

// Textarea de edição inline — Enter salva, Shift+Enter quebra linha, Escape
// cancela, mesmo padrão de atalho do compositor principal de mensagem.
function MessageEditForm({
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
      <div className="message-edit-hint">
        escape para cancelar · enter para salvar
      </div>
    </div>
  );
}

// Sem picker de emoji completo ainda (busca/categorias — ver
// DISCORD_PARITY_PLAN.md): paleta curada fixa, igual servidor e cliente
// validam contra a mesma lista em REACTION_EMOJI.
function ReactionPicker({ onSelect, onClose }: { onSelect: (emoji: ReactionEmoji) => void; onClose: () => void }) {
  useEffect(() => {
    const handlePointerDown = () => onClose();
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [onClose]);

  return (
    <div className="reaction-picker" onMouseDown={(event) => event.stopPropagation()} role="menu" aria-label="Escolher reação">
      {REACTION_EMOJI.map((emoji) => (
        <button key={emoji} type="button" role="menuitem" onClick={() => onSelect(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
  );
}

function ReactionBar({
  message,
  ownUserId,
  onToggle,
}: {
  message: TextMessage;
  ownUserId: string;
  onToggle: (emoji: ReactionEmoji, reacted: boolean) => void;
}) {
  if (!message.reactions?.length) return null;
  return (
    <div className="message-reactions">
      {message.reactions.map((group) => {
        const reacted = group.userIds.includes(ownUserId);
        return (
          <button
            key={group.emoji}
            type="button"
            className={`reaction-pill ${reacted ? 'reacted' : ''}`}
            onClick={() => onToggle(group.emoji, reacted)}
            title={reacted ? 'Você reagiu — clique para remover' : `${group.userIds.length} reação(ões)`}
          >
            <span aria-hidden="true">{group.emoji}</span>
            <span>{group.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}

// Só o id é guardado (ver comentário em TextMessage.replyToMessageId no
// pacote compartilhado) — resolve contra as mensagens já carregadas nesta
// conversa; se não achar (fora da janela de 100, ou apagada), mostra um
// placeholder honesto em vez de fingir que tem o conteúdo.
function ReplyPreview({
  replyTarget,
  onJump,
}: {
  replyTarget: TextMessage | undefined;
  onJump: () => void;
}) {
  return (
    <button type="button" className="message-reply-preview" onClick={onJump} disabled={!replyTarget}>
      <ReplyIcon size={11} />
      {replyTarget ? (
        <>
          <strong>{replyTarget.senderName}</strong>
          <span>{replyTarget.text}</span>
        </>
      ) : (
        <em>Mensagem original não encontrada</em>
      )}
    </button>
  );
}

function HumanTextMessageRow({
  message,
  continued,
  session,
  onOpenProfile,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggleReaction,
  onReply,
  replyTarget,
  onJumpToMessage,
}: {
  message: TextMessage;
  continued: boolean;
  session: UserSession;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => Promise<void>;
  onDelete: () => void;
  onToggleReaction: (emoji: ReactionEmoji, reacted: boolean) => void;
  onReply: () => void;
  replyTarget: TextMessage | undefined;
  onJumpToMessage: (messageId: string) => void;
}) {
  const avatarUrl = useTextAvatar(message.senderId, session);
  const initial = message.senderName.trim().charAt(0).toUpperCase() || '?';
  const isOwn = message.senderId === session.id;
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  return (
    <article id={`message-${message.id}`} className={`message text-message ${continued ? 'continued' : ''}`}>
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
        {message.replyToMessageId && (
          <ReplyPreview replyTarget={replyTarget} onJump={() => onJumpToMessage(message.replyToMessageId!)} />
        )}
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
          {message.editedAt && <span className="message-edited-mark" title="Mensagem editada">(editado)</span>}
        </header>
        {isEditing ? (
          <MessageEditForm initialText={message.text} onSave={onSaveEdit} onCancel={onCancelEdit} />
        ) : (
          <p><MarkdownText text={message.text} /></p>
        )}
        <ReactionBar message={message} ownUserId={session.id} onToggle={onToggleReaction} />
      </div>
      {!isEditing && (
        <div className="message-hover-actions" role="toolbar" aria-label="Ações da mensagem">
          <button type="button" title="Responder" aria-label="Responder" onClick={onReply}>
            <ReplyIcon size={14} />
          </button>
          <button type="button" title="Copiar texto" aria-label="Copiar texto" onClick={() => void navigator.clipboard.writeText(message.text)}>
            <CopyIcon size={14} />
          </button>
          <div className="reaction-picker-anchor">
            <button type="button" title="Adicionar reação" aria-label="Adicionar reação" onClick={() => setShowReactionPicker((open) => !open)}>
              <SmileIcon size={14} />
            </button>
            {showReactionPicker && (
              <ReactionPicker
                onSelect={(emoji) => {
                  setShowReactionPicker(false);
                  onToggleReaction(emoji, false);
                }}
                onClose={() => setShowReactionPicker(false)}
              />
            )}
          </div>
          {isOwn && (
            <>
              <button type="button" title="Editar mensagem" aria-label="Editar mensagem" onClick={onStartEdit}>
                <EditIcon size={14} />
              </button>
              <button type="button" title="Apagar mensagem" aria-label="Apagar mensagem" onClick={onDelete}>
                <TrashIcon size={14} />
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function TextMessageRow(props: {
  message: TextMessage;
  continued: boolean;
  session: UserSession;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
  onMusicCommand: (command: string) => Promise<MusicCommandResponse>;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => Promise<void>;
  onDelete: () => void;
  onToggleReaction: (emoji: ReactionEmoji, reacted: boolean) => void;
  onReply: () => void;
  replyTarget: TextMessage | undefined;
  onJumpToMessage: (messageId: string) => void;
}) {
  return props.message.senderType === 'BOT'
    ? <BotTextMessageRow message={props.message} onMusicCommand={props.onMusicCommand} />
    : (
      <HumanTextMessageRow
        message={props.message}
        continued={props.continued}
        session={props.session}
        onOpenProfile={props.onOpenProfile}
        isEditing={props.isEditing}
        onStartEdit={props.onStartEdit}
        onCancelEdit={props.onCancelEdit}
        onSaveEdit={props.onSaveEdit}
        onDelete={props.onDelete}
        onToggleReaction={props.onToggleReaction}
        onReply={props.onReply}
        replyTarget={props.replyTarget}
        onJumpToMessage={props.onJumpToMessage}
      />
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
  const [feedback, setFeedback] = useState<MusicCommandResponse | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<TextMessage | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isTimedOut = Boolean(session.timeoutUntil && session.timeoutUntil > Date.now());

  // Só destaca visualmente se a mensagem original estiver na janela já
  // carregada (até 100 mensagens) — sem isso, não há pra onde rolar.
  function jumpToMessage(messageId: string) {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.classList.add('message-jump-highlight');
    window.setTimeout(() => element.classList.remove('message-jump-highlight'), 1_500);
  }

  async function saveMessageEdit(messageId: string, text: string) {
    try {
      const { message } = await api.editTextMessage(channel.id, messageId, text);
      setMessages((current) => applyIncomingMessage(current, message));
      setEditingMessageId(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível editar a mensagem.');
    }
  }

  async function deleteMessage(messageId: string) {
    if (!window.confirm('Apagar esta mensagem? Essa ação não pode ser desfeita.')) return;
    try {
      await api.deleteTextMessage(channel.id, messageId);
      setMessages((current) => current.filter(({ id }) => id !== messageId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível apagar a mensagem.');
    }
  }

  // Aplica localmente na hora (sem esperar o eco do próprio WebSocket) pra
  // parecer instantâneo; o eco chega de qualquer forma e é idempotente.
  async function toggleReaction(messageId: string, emoji: ReactionEmoji, reacted: boolean) {
    setMessages((current) => applyReactionChange(current, messageId, emoji, session.id, reacted ? 'remove' : 'add'));
    try {
      if (reacted) await api.removeReaction(channel.id, messageId, emoji);
      else await api.addReaction(channel.id, messageId, emoji);
    } catch {
      // Reverte o otimismo local — o próximo fetch/reconexão também corrigiria.
      setMessages((current) => applyReactionChange(current, messageId, emoji, session.id, reacted ? 'add' : 'remove'));
    }
  }

  useEffect(() => {
    let active = true;
    let requestRunning = false;
    setMessages([]);
    setDraft('');
    setLoading(true);
    setError('');
    setFeedback(null);
    setEditingMessageId(null);
    setReplyingTo(null);

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
    // Sem poll: o WebSocket empurra criação/atualização/remoção em tempo
    // real (ver assinatura abaixo). Ao reconectar depois de ficar offline,
    // refaz esse fetch pra resincronizar qualquer coisa perdida no meio.
    const unsubscribeReconnect = onRealtimeConnect(() => void refresh());
    return () => {
      active = false;
      unsubscribeReconnect();
    };
  }, [channel.id]);

  useEffect(() => {
    return onRealtimeEvent((event) => {
      if (event.type === 'TEXT_MESSAGE_CREATE' || event.type === 'TEXT_MESSAGE_UPSERT') {
        if (event.channelId !== channel.id) return;
        setMessages((current) => applyIncomingMessage(current, event.message));
        window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      } else if (event.type === 'TEXT_MESSAGE_DELETE') {
        if (event.channelId !== channel.id) return;
        setMessages((current) => current.filter(({ id }) => id !== event.messageId));
      } else if (event.type === 'TEXT_MESSAGE_REACTION_ADD' || event.type === 'TEXT_MESSAGE_REACTION_REMOVE') {
        if (event.channelId !== channel.id) return;
        const action = event.type === 'TEXT_MESSAGE_REACTION_ADD' ? 'add' : 'remove';
        setMessages((current) => applyReactionChange(current, event.messageId, event.emoji, event.userId, action));
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
    setFeedback(null);
    try {
      const result = await routeTextChannelInput({
        text,
        voiceChannelId,
        textChannelId: channel.id,
        sendMusicCommand: api.sendMusicCommand,
        sendTextMessage: async (messageText) =>
          (await api.sendTextMessage(channel.id, messageText, replyingTo?.id)).message,
      });
      setReplyingTo(null);
      if (result.kind === 'text-message') {
        const { message } = result;
        setMessages((current) => applyIncomingMessage(current, message));
        window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      } else if (result.response.textMessage) {
        const botMessage = result.response.textMessage;
        setMessages((current) => applyIncomingMessage(current, botMessage));
        window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      } else if (result.response.removeTextMessage) {
        setMessages((current) => current.filter(({ senderType }) => senderType !== 'BOT'));
        setFeedback(result.response);
      } else {
        setFeedback(result.response);
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
      {feedback && <div className="music-command-feedback" role="status"><span>{feedback.message}</span>{feedback.nowPlaying && <MusicCard card={feedback.nowPlaying} />}</div>}
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
              isEditing={editingMessageId === message.id}
              onStartEdit={() => setEditingMessageId(message.id)}
              onCancelEdit={() => setEditingMessageId(null)}
              onSaveEdit={(text) => saveMessageEdit(message.id, text)}
              onDelete={() => void deleteMessage(message.id)}
              onToggleReaction={(emoji, reacted) => void toggleReaction(message.id, emoji, reacted)}
              onReply={() => {
                setReplyingTo(message);
                inputRef.current?.focus();
              }}
              replyTarget={message.replyToMessageId ? messages.find(({ id }) => id === message.replyToMessageId) : undefined}
              onJumpToMessage={jumpToMessage}
              onMusicCommand={async (commandText) => {
                if (!voiceChannelId) {
                  throw new Error('Você precisa estar em um canal de voz para usar os controles do SausiMusic.');
                }
                const response = await api.sendMusicCommand(voiceChannelId, commandText, channel.id);
                if (response.removeTextMessage) {
                  setMessages((current) => current.filter(({ senderType }) => senderType !== 'BOT'));
                } else if (response.textMessage) {
                  setMessages((current) => applyIncomingMessage(current, response.textMessage!));
                }
                return response;
              }}
            />
          );
        })}
        <div ref={endRef} />
      </div>
      {replyingTo && (
        <div className="reply-composer-banner">
          <ReplyIcon size={13} />
          <span>Respondendo a <strong>{replyingTo.senderName}</strong></span>
          <button type="button" aria-label="Cancelar resposta" onClick={() => setReplyingTo(null)}>
            <CloseIcon size={13} />
          </button>
        </div>
      )}
      {isTimedOut && session.timeoutUntil && (
        <div className="reply-composer-banner timeout-composer-banner">
          <span>
            Você está em timeout e não pode enviar mensagens até{' '}
            {new Date(session.timeoutUntil).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.
          </span>
        </div>
      )}
      <form className="text-channel-form" onSubmit={submitMessage}>
        <label className="sr-only" htmlFor="text-channel-message">Mensagem para #{channel.name}</label>
        <textarea
          ref={inputRef}
          id="text-channel-message"
          rows={1}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          value={draft}
          disabled={isTimedOut}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={isTimedOut ? 'Você está em timeout' : `Conversar em #${channel.name}`}
        />
        <div className="text-channel-form-meta">
          <span>{draft.length}/{CHAT_MESSAGE_MAX_LENGTH}</span>
          <button type="submit" disabled={isTimedOut || sending || !draft.trim()}>
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

import { useEffect, useState } from 'react';
import type {
  BlockedUserSummary,
  DmChannel,
  FriendRequestSummary,
  FriendshipStatus,
  FriendSummary,
  MemberSummary,
  UserSession,
} from '@sausixudos/shared';
import { api } from '../api';
import { onRealtimeConnect, onRealtimeEvent } from '../realtime';
import { Avatar } from './Workspace';
import { CloseIcon, MessageIcon, SearchIcon, UserIcon, UserPlusIcon } from './Icons';

export interface FriendsState {
  friends: FriendSummary[];
  incoming: FriendRequestSummary[];
  outgoing: FriendRequestSummary[];
  blocked: BlockedUserSummary[];
  dmChannels: DmChannel[];
}

// Deriva a perspectiva de UM usuário a partir das listas já carregadas — mais
// simples do que carregar o fato bruto (status+requestedBy) do banco pra
// cada usuário exibido, já que GET /api/friends e GET /api/friends/requests
// já devolvem exatamente essas listas prontas.
export function relationshipStatus(userId: string, state: FriendsState): FriendshipStatus {
  if (state.friends.some((friend) => friend.id === userId)) return 'ACCEPTED';
  if (state.incoming.some((request) => request.userId === userId)) return 'PENDING_INCOMING';
  if (state.outgoing.some((request) => request.userId === userId)) return 'PENDING_OUTGOING';
  return 'NONE';
}

export function isBlockedByMe(userId: string, state: FriendsState): boolean {
  return state.blocked.some((entry) => entry.userId === userId);
}

// Centralizado em Workspace.tsx (não em componentes filhos) — um único fetch
// + assinatura de tempo real alimenta o badge de pedidos pendentes no
// server-rail, o popover de perfil, e as telas de Amigos/DM ao mesmo tempo.
export function useFriendsState(session: UserSession): FriendsState & { refresh: () => void } {
  const [friends, setFriends] = useState<FriendSummary[]>([]);
  const [incoming, setIncoming] = useState<FriendRequestSummary[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequestSummary[]>([]);
  const [blocked, setBlocked] = useState<BlockedUserSummary[]>([]);
  const [dmChannels, setDmChannels] = useState<DmChannel[]>([]);

  function refreshFriends() {
    void api.getFriends().then(({ friends }) => setFriends(friends)).catch(() => {});
    void api.getFriendRequests().then(({ incoming, outgoing }) => {
      setIncoming(incoming);
      setOutgoing(outgoing);
    }).catch(() => {});
  }

  function refreshAll() {
    refreshFriends();
    void api.getBlocks().then(({ blocks }) => setBlocked(blocks)).catch(() => {});
    void api.getDmChannels().then(({ channels }) => setDmChannels(channels)).catch(() => {});
  }

  useEffect(() => {
    refreshAll();
    const unsubscribeConnect = onRealtimeConnect(refreshAll);
    const unsubscribeEvent = onRealtimeEvent((event) => {
      if (event.type === 'FRIENDSHIP_UPDATE' && event.participantIds.includes(session.id)) {
        refreshFriends();
      } else if (event.type === 'BLOCK_UPDATE') {
        void api.getBlocks().then(({ blocks }) => setBlocked(blocks)).catch(() => {});
      } else if (event.type === 'DM_CHANNEL_CREATE') {
        setDmChannels((current) => (current.some(({ id }) => id === event.channel.id) ? current : [event.channel, ...current]));
      } else if (event.type === 'DM_MESSAGE_CREATE' || event.type === 'DM_MESSAGE_UPSERT') {
        setDmChannels((current) => {
          const next = current.map((channel) =>
            channel.id === event.dmChannelId ? { ...channel, lastMessageAt: event.message.sentAt } : channel,
          );
          return [...next].sort((left, right) => (right.lastMessageAt ?? right.createdAt) - (left.lastMessageAt ?? left.createdAt));
        });
      }
    });
    return () => {
      unsubscribeConnect();
      unsubscribeEvent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return { friends, incoming, outgoing, blocked, dmChannels, refresh: refreshAll };
}

export function FriendsSidebar({
  dmChannels,
  ownId,
  activeDmChannelId,
  pendingCount,
  onSelectDm,
  onBackToHome,
}: {
  dmChannels: DmChannel[];
  ownId: string;
  activeDmChannelId: string | null;
  pendingCount: number;
  onSelectDm: (dmChannelId: string) => void;
  onBackToHome: () => void;
}) {
  return (
    <>
      <header className="sidebar-header">
        <button type="button" className="server-menu-trigger" onClick={onBackToHome}>
          <strong>Amigos</strong>
        </button>
      </header>
      <nav className="channels" aria-label="Conversas diretas">
        <div className="dm-nav-list">
          <button type="button" className={`text-channel-button dm-home-button ${!activeDmChannelId ? 'active' : ''}`} onClick={onBackToHome}>
            <UserIcon size={16} />
            <span>Amigos</span>
            {pendingCount > 0 && <span className="dm-pending-badge">{pendingCount}</span>}
          </button>
        </div>
        <div className="section-title"><span>MENSAGENS DIRETAS</span></div>
        <div className="text-channel-list">
          {dmChannels.length === 0 ? (
            <p className="dm-list-empty">Nenhuma conversa ainda.</p>
          ) : (
            dmChannels.map((channel) => {
              const other = channel.participants.find((participant) => participant.id !== ownId);
              if (!other) return null;
              const active = channel.id === activeDmChannelId;
              return (
                <button
                  type="button"
                  key={channel.id}
                  className={`text-channel-button dm-channel-button ${active ? 'active' : ''}`}
                  onClick={() => onSelectDm(channel.id)}
                >
                  <Avatar name={other.displayName} accentColor={other.accentColor} avatarUrl={other.avatarUrl} compact />
                  <span>{other.displayName}</span>
                </button>
              );
            })
          )}
        </div>
      </nav>
    </>
  );
}

type FriendsTab = 'all' | 'pending' | 'blocked' | 'add';

function AddFriendTab({
  state,
  ownId,
  onOpenProfile,
}: {
  state: FriendsState;
  ownId: string;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
}) {
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getMembers().then(({ members }) => setMembers(members)).catch(() => {});
  }, []);

  async function addFriend(userId: string) {
    setFeedback((current) => ({ ...current, [userId]: '' }));
    try {
      const { status } = await api.sendFriendRequest(userId);
      setFeedback((current) => ({ ...current, [userId]: status === 'ACCEPTED' ? 'Agora vocês são amigos!' : 'Pedido enviado.' }));
    } catch (error) {
      setFeedback((current) => ({ ...current, [userId]: error instanceof Error ? error.message : 'Não foi possível enviar o pedido.' }));
    }
  }

  const query = search.trim().toLowerCase();
  const results = members
    .filter((member) => member.id !== ownId)
    .filter((member) => !query || member.displayName.toLowerCase().includes(query));

  return (
    <div className="friends-add-tab">
      <label className="roles-search friends-add-search">
        <SearchIcon size={14} />
        <input placeholder="Buscar por nome" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="friends-list">
        {results.map((member) => {
          const status = relationshipStatus(member.id, state);
          return (
            <div className="friend-row" key={member.id}>
              <button type="button" className="friend-row-identity" onClick={(event) => onOpenProfile(member.id, event)}>
                <Avatar name={member.displayName} accentColor={member.accentColor} avatarUrl={member.avatarUrl} />
                <span>{member.displayName}</span>
              </button>
              <div className="friend-row-actions">
                {feedback[member.id] && <small className="friend-row-feedback">{feedback[member.id]}</small>}
                {status === 'NONE' && (
                  <button type="button" className="secondary-pill" onClick={() => void addFriend(member.id)}>
                    <UserPlusIcon size={13} /> Adicionar
                  </button>
                )}
                {status === 'PENDING_OUTGOING' && <span className="friend-row-status">Pedido enviado</span>}
                {status === 'PENDING_INCOMING' && <span className="friend-row-status">Pedido recebido</span>}
                {status === 'ACCEPTED' && <span className="friend-row-status">Já são amigos</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FriendsHome({
  state,
  ownId,
  onOpenProfile,
  onOpenDm,
  onRefresh,
}: {
  state: FriendsState;
  ownId: string;
  onOpenProfile: (userId: string, event: { currentTarget: HTMLElement }) => void;
  onOpenDm: (userId: string) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<FriendsTab>(state.incoming.length > 0 ? 'pending' : 'all');

  async function respond(userId: string, accept: boolean) {
    try {
      if (accept) await api.sendFriendRequest(userId);
      else await api.removeFriendship(userId);
      onRefresh();
    } catch {
      // O usuário pode tentar de novo pelo mesmo botão.
    }
  }

  async function remove(userId: string) {
    if (!window.confirm('Remover esse amigo?')) return;
    try {
      await api.removeFriendship(userId);
      onRefresh();
    } catch {
      // idem
    }
  }

  async function unblock(userId: string) {
    try {
      await api.unblockUser(userId);
      onRefresh();
    } catch {
      // idem
    }
  }

  return (
    <div className="friends-home">
      <div className="server-page-title">
        <div><h1>Amigos</h1><p>Gerencie suas amizades, pedidos e bloqueios.</p></div>
      </div>
      <div className="friends-tabs">
        <button type="button" className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
          Todos — {state.friends.length}
        </button>
        <button type="button" className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
          Pendentes {state.incoming.length > 0 ? `— ${state.incoming.length}` : ''}
        </button>
        <button type="button" className={tab === 'blocked' ? 'active' : ''} onClick={() => setTab('blocked')}>
          Bloqueados — {state.blocked.length}
        </button>
        <button type="button" className={`friends-tab-add ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
          <UserPlusIcon size={14} /> Adicionar amigo
        </button>
      </div>

      {tab === 'all' && (
        <div className="friends-list">
          {state.friends.length === 0 ? (
            <p className="friends-empty">Você ainda não tem amigos adicionados.</p>
          ) : (
            state.friends.map((friend) => (
              <div className="friend-row" key={friend.id}>
                <button type="button" className="friend-row-identity" onClick={(event) => onOpenProfile(friend.id, event)}>
                  <Avatar name={friend.displayName} accentColor={friend.accentColor} avatarUrl={friend.avatarUrl} />
                  <span>{friend.displayName}</span>
                  {friend.statusText && <small>{friend.statusText}</small>}
                </button>
                <div className="friend-row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Enviar mensagem"
                    aria-label="Enviar mensagem"
                    onClick={() => (friend.dmChannelId ? onOpenDm(friend.id) : void api.openDmChannel(friend.id).then(() => onOpenDm(friend.id)))}
                  >
                    <MessageIcon size={16} />
                  </button>
                  <button type="button" className="icon-button" title="Remover amigo" aria-label="Remover amigo" onClick={() => void remove(friend.id)}>
                    <CloseIcon size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'pending' && (
        <div className="friends-list">
          {state.incoming.length === 0 && state.outgoing.length === 0 ? (
            <p className="friends-empty">Nenhum pedido de amizade pendente.</p>
          ) : (
            <>
              {state.incoming.map((request) => (
                <div className="friend-row" key={request.userId}>
                  <button type="button" className="friend-row-identity" onClick={(event) => onOpenProfile(request.userId, event)}>
                    <Avatar name={request.displayName} accentColor={request.accentColor} avatarUrl={request.avatarUrl} />
                    <span>{request.displayName}</span>
                    <small>pediu amizade</small>
                  </button>
                  <div className="friend-row-actions">
                    <button type="button" className="secondary-pill" onClick={() => void respond(request.userId, true)}>Aceitar</button>
                    <button type="button" className="secondary-pill" onClick={() => void respond(request.userId, false)}>Recusar</button>
                  </div>
                </div>
              ))}
              {state.outgoing.map((request) => (
                <div className="friend-row" key={request.userId}>
                  <button type="button" className="friend-row-identity" onClick={(event) => onOpenProfile(request.userId, event)}>
                    <Avatar name={request.displayName} accentColor={request.accentColor} avatarUrl={request.avatarUrl} />
                    <span>{request.displayName}</span>
                    <small>pedido enviado</small>
                  </button>
                  <div className="friend-row-actions">
                    <button type="button" className="secondary-pill" onClick={() => void remove(request.userId)}>Cancelar</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'blocked' && (
        <div className="friends-list">
          {state.blocked.length === 0 ? (
            <p className="friends-empty">Nenhum usuário bloqueado.</p>
          ) : (
            state.blocked.map((entry) => (
              <div className="friend-row" key={entry.userId}>
                <div className="friend-row-identity">
                  <Avatar name={entry.displayName} accentColor={entry.accentColor} avatarUrl={entry.avatarUrl} />
                  <span>{entry.displayName}</span>
                </div>
                <div className="friend-row-actions">
                  <button type="button" className="secondary-pill" onClick={() => void unblock(entry.userId)}>Desbloquear</button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'add' && <AddFriendTab state={state} ownId={ownId} onOpenProfile={onOpenProfile} />}
    </div>
  );
}

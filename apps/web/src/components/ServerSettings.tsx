import { useEffect, useMemo, useState } from 'react';
import {
  EVERYONE_ROLE_ID,
  hasPermission,
  PERMISSION_DEFINITIONS,
  Permission,
  ROLE_NAME_MAX_LENGTH,
  type BanRecord,
  type MemberSummary,
  type Role,
  type UserSession,
} from '@sausixudos/shared';
import { api } from '../api';
import { onRealtimeEvent } from '../realtime';
import { CloseIcon, PlusIcon, SearchIcon, SettingsIcon, TrashIcon, UserIcon } from './Icons';

type ServerSettingsSection = 'profile' | 'roles' | 'members';

const ROLE_COLOR_SWATCHES = ['#7c6ff2', '#4fc6ad', '#ee7798', '#f2ad5c', '#4f8edc', '#a76de0', '#68708b', '#8a91a6'];

function isFlagSet(bitfield: number, flag: number): boolean {
  return (bitfield & flag) !== 0;
}

function highestPosition(roleIds: string[], roles: Role[]): number {
  let max = 0;
  for (const roleId of roleIds) {
    const role = roles.find((candidate) => candidate.id === roleId);
    if (role && role.position > max) max = role.position;
  }
  return max;
}

function formatTimeoutUntil(timestamp: number): string {
  return new Date(timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ServerSettings({ open, onClose, session }: { open: boolean; onClose: () => void; session: UserSession }) {
  const [section, setSection] = useState<ServerSettingsSection>('profile');

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <section className="server-settings-shell" aria-label="Configurações do servidor">
      <nav className="server-settings-nav">
        <div className="server-settings-heading">
          <span className="server-settings-avatar">S</span>
          <div><strong>Lobby dos amigos</strong><span>Configurações do servidor</span></div>
        </div>
        <span className="settings-nav-group">Servidor</span>
        <button type="button" className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')}>
          <SettingsIcon size={17} /> Perfil do servidor
        </button>
        <button type="button"><span className="nav-glyph">⌁</span> Visão geral</button>
        <button type="button"><span className="nav-glyph">✦</span> Impulsos</button>
        <span className="settings-nav-group">Pessoas</span>
        <button type="button" className={section === 'roles' ? 'active' : ''} onClick={() => setSection('roles')}>
          <UserIcon size={17} /> Cargos
        </button>
        <button type="button" className={section === 'members' ? 'active' : ''} onClick={() => setSection('members')}>
          <span className="nav-glyph">♙</span> Membros
        </button>
        <button type="button"><span className="nav-glyph">⌘</span> Convites</button>
        <span className="settings-nav-group">Moderação</span>
        <button type="button"><span className="nav-glyph">◇</span> Segurança</button>
        <button type="button"><span className="nav-glyph">▤</span> Registro de auditoria</button>
        <span className="settings-nav-group">Comunidade</span>
        <button type="button"><span className="nav-glyph">◉</span> Integrações</button>
        <button type="button"><span className="nav-glyph">▱</span> Widgets</button>
        <div className="server-settings-nav-spacer" />
        <button type="button" className="server-settings-danger"><span className="nav-glyph">⊘</span> Excluir servidor</button>
      </nav>

      <div className="server-settings-content">
        {section === 'profile' && <ServerProfilePane />}
        {section === 'roles' && <RolesPane session={session} />}
        {section === 'members' && <MembersPane session={session} />}
      </div>
      <button type="button" className="server-settings-close" onClick={onClose} aria-label="Fechar configurações do servidor">
        <CloseIcon size={20} /><span>ESC</span>
      </button>
    </section>
  );
}

function ServerProfilePane() {
  return (
    <div className="server-profile-page">
      <div className="server-page-title">
        <div><h1>Perfil do servidor</h1><p>Personalize a aparência e a identidade do seu servidor.</p></div>
        <button type="button" className="secondary-pill">Pré-visualizar</button>
      </div>
      <div className="server-profile-columns">
        <div className="server-profile-form">
          <section className="server-settings-card server-banner-card">
            <span className="field-eyebrow">Banner do servidor</span>
            <div className="server-banner-preview">
              <div className="server-banner-art"><i /><i /><i /></div>
              <button type="button" className="banner-edit-button">✎</button>
            </div>
            <p>Recomendado: 1920 × 480. PNG, JPG ou WEBP.</p>
          </section>
          <section className="server-settings-card server-identity-card">
            <div className="server-icon-large">S<span>✎</span></div>
            <div className="server-name-fields">
              <label>Nome do servidor<input readOnly value="Lobby dos amigos" /></label>
              <label>Descrição<textarea readOnly rows={3} value="Um lugar para conversar, jogar e compartilhar bons momentos." /></label>
            </div>
          </section>
          <section className="server-settings-card">
            <label>Cor de destaque</label>
            <div className="static-swatches" aria-label="Cores de destaque">
              {['#7c6ff2', '#4fc6ad', '#ee7798', '#f2ad5c', '#4f8edc', '#a76de0', '#68708b'].map((color, index) => (
                <button key={color} type="button" className={index === 0 ? 'selected' : ''} style={{ background: color }} aria-label={`Cor ${index + 1}`} />
              ))}
            </div>
          </section>
          <div className="server-form-actions">
            <button type="button" className="secondary-pill">Descartar</button>
            <button type="button" className="violet-primary">Salvar alterações</button>
          </div>
        </div>
        <aside className="server-live-preview">
          <span className="field-eyebrow">Pré-visualização</span>
          <div className="server-preview-card">
            <div className="server-preview-banner"><i /><i /><i /></div>
            <div className="server-preview-body">
              <span className="server-icon-large">S</span>
              <h2>Lobby dos amigos</h2>
              <p>Um lugar para conversar, jogar e compartilhar bons momentos.</p>
              <div><span>● 5 online</span><span>9 membros</span></div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

type RoleTab = 'display' | 'permissions' | 'members';

function RolesPane({ session }: { session: UserSession }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [tab, setTab] = useState<RoleTab>('display');
  const [creating, setCreating] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [error, setError] = useState('');
  const [memberSearch, setMemberSearch] = useState('');

  useEffect(() => {
    let active = true;
    void Promise.all([api.getRoles(), api.getMembers()]).then(([rolesResult, membersResult]) => {
      if (!active) return;
      setRoles(rolesResult.roles);
      setMembers(membersResult.members);
      setSelectedRoleId((current) => current ?? rolesResult.roles[0]?.id ?? null);
    });
    const unsubscribe = onRealtimeEvent((event) => {
      if (event.type === 'ROLE_CREATE') {
        setRoles((current) => [...current, event.role].sort((left, right) => right.position - left.position));
      } else if (event.type === 'ROLE_UPDATE') {
        setRoles((current) => current.map((role) => (role.id === event.role.id ? event.role : role)));
      } else if (event.type === 'ROLE_DELETE') {
        setRoles((current) => current.filter((role) => role.id !== event.roleId));
        setSelectedRoleId((current) => (current === event.roleId ? null : current));
      } else if (event.type === 'MEMBER_ROLES_UPDATE') {
        setMembers((current) =>
          current.map((member) => (member.id === event.userId ? { ...member, roleIds: event.roleIds } : member)),
        );
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const ownPosition = useMemo(() => highestPosition(session.roleIds, roles), [session.roleIds, roles]);
  const canManageRoles = hasPermission(session.permissions, Permission.MANAGE_ROLES);
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null;
  const canEditSelected = Boolean(selectedRole) && canManageRoles && selectedRole!.position < ownPosition;

  async function createRole() {
    if (!newRoleName.trim()) return;
    setError('');
    try {
      const { role } = await api.createRole(
        newRoleName.trim(),
        ROLE_COLOR_SWATCHES[roles.length % ROLE_COLOR_SWATCHES.length] ?? '#7c6ff2',
        0,
        false,
      );
      setRoles((current) => [...current, role].sort((left, right) => right.position - left.position));
      setSelectedRoleId(role.id);
      setTab('display');
      setNewRoleName('');
      setCreating(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível criar o cargo.');
    }
  }

  async function patchSelectedRole(patch: { name?: string; color?: string; permissions?: number; hoist?: boolean }) {
    if (!selectedRole) return;
    setError('');
    try {
      const { role } = await api.updateRole(selectedRole.id, patch);
      setRoles((current) => current.map((candidate) => (candidate.id === role.id ? role : candidate)));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível atualizar o cargo.');
    }
  }

  async function removeSelectedRole() {
    if (!selectedRole || selectedRole.id === EVERYONE_ROLE_ID) return;
    if (!window.confirm(`Apagar o cargo "${selectedRole.name}"? Essa ação não pode ser desfeita.`)) return;
    try {
      await api.deleteRole(selectedRole.id);
      setRoles((current) => current.filter((role) => role.id !== selectedRole.id));
      setSelectedRoleId(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível apagar o cargo.');
    }
  }

  async function toggleMemberInRole(userId: string, hasRole: boolean) {
    if (!selectedRole) return;
    try {
      if (hasRole) {
        await api.unassignRole(selectedRole.id, userId);
        setMembers((current) =>
          current.map((member) =>
            member.id === userId ? { ...member, roleIds: member.roleIds.filter((id) => id !== selectedRole.id) } : member,
          ),
        );
      } else {
        await api.assignRole(selectedRole.id, userId);
        setMembers((current) =>
          current.map((member) => (member.id === userId ? { ...member, roleIds: [...member.roleIds, selectedRole.id] } : member)),
        );
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível alterar a atribuição do cargo.');
    }
  }

  const groupedPermissions = useMemo(() => {
    const groups = new Map<string, typeof PERMISSION_DEFINITIONS>();
    for (const definition of PERMISSION_DEFINITIONS) {
      const list = groups.get(definition.category) ?? [];
      list.push(definition);
      groups.set(definition.category, list);
    }
    return [...groups.entries()];
  }, []);

  const filteredMembers = members.filter((member) => member.displayName.toLowerCase().includes(memberSearch.trim().toLowerCase()));

  return (
    <div className="roles-page">
      <div className="server-page-title">
        <div><h1>Cargos</h1><p>Use cargos para organizar os membros e controlar permissões.</p></div>
        {canManageRoles && (
          <button type="button" className="violet-primary" onClick={() => setCreating((current) => !current)}>
            <PlusIcon size={15} /> Criar cargo
          </button>
        )}
      </div>
      {creating && (
        <div className="role-create-row">
          <input
            value={newRoleName}
            maxLength={ROLE_NAME_MAX_LENGTH}
            placeholder="Nome do novo cargo"
            onChange={(event) => setNewRoleName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void createRole()}
          />
          <button type="button" className="violet-primary" onClick={() => void createRole()}>Criar</button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="roles-workspace">
        <aside className="roles-list">
          <label className="roles-search"><SearchIcon size={14} /><input readOnly placeholder="Buscar cargos" /></label>
          <span className="field-eyebrow">Cargos — {roles.length}</span>
          {roles.map((role) => {
            const memberCount = members.filter((member) => member.roleIds.includes(role.id)).length;
            return (
              <button
                type="button"
                key={role.id}
                className={role.id === selectedRoleId ? 'active' : ''}
                onClick={() => {
                  setSelectedRoleId(role.id);
                  setTab('display');
                }}
              >
                <i style={{ background: role.color }} />
                <span><strong>{role.name}</strong><small>{memberCount} membro{memberCount === 1 ? '' : 's'}</small></span>
              </button>
            );
          })}
        </aside>
        {selectedRole ? (
          <section className="role-editor">
            <div className="role-editor-heading">
              <div>
                <span className="role-color-dot" style={{ background: selectedRole.color }} />
                <h2>{selectedRole.name}</h2>
                <small>{members.filter((member) => member.roleIds.includes(selectedRole.id)).length} membros</small>
              </div>
              {canEditSelected && selectedRole.id !== EVERYONE_ROLE_ID && (
                <button type="button" onClick={() => void removeSelectedRole()} aria-label="Apagar cargo">
                  <TrashIcon size={14} />
                </button>
              )}
            </div>
            <div className="role-tabs">
              <button type="button" className={tab === 'display' ? 'active' : ''} onClick={() => setTab('display')}>Exibição</button>
              <button type="button" className={tab === 'permissions' ? 'active' : ''} onClick={() => setTab('permissions')}>Permissões</button>
              <button type="button" className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>Gerenciar membros</button>
            </div>

            {tab === 'display' && (
              <>
                <div className="role-fields-grid">
                  <label>
                    Nome do cargo
                    <input
                      value={selectedRole.name}
                      disabled={!canEditSelected || selectedRole.id === EVERYONE_ROLE_ID}
                      maxLength={ROLE_NAME_MAX_LENGTH}
                      onChange={(event) => setRoles((current) => current.map((role) => (role.id === selectedRole.id ? { ...role, name: event.target.value } : role)))}
                      onBlur={(event) => void patchSelectedRole({ name: event.target.value.trim() || selectedRole.name })}
                    />
                  </label>
                  <label>
                    Cor do cargo
                    <div className="static-swatches" aria-label="Cor do cargo">
                      {ROLE_COLOR_SWATCHES.map((color) => (
                        <button
                          key={color}
                          type="button"
                          disabled={!canEditSelected}
                          className={color === selectedRole.color ? 'selected' : ''}
                          style={{ background: color }}
                          aria-label={`Cor ${color}`}
                          onClick={() => void patchSelectedRole({ color })}
                        />
                      ))}
                    </div>
                  </label>
                </div>
                {selectedRole.id !== EVERYONE_ROLE_ID && (
                  <div className="role-static-toggle">
                    <div><strong>Exibir membros do cargo separadamente</strong><span>Mostra este cargo como um grupo próprio na lista de membros.</span></div>
                    <button
                      type="button"
                      disabled={!canEditSelected}
                      className={`static-switch${selectedRole.hoist ? ' on' : ''}`}
                      onClick={() => void patchSelectedRole({ hoist: !selectedRole.hoist })}
                    />
                  </div>
                )}
              </>
            )}

            {tab === 'permissions' && (
              <>
                <div className="permissions-heading">
                  <div><h3>Permissões</h3><p>Defina o que os membros deste cargo podem fazer.</p></div>
                </div>
                {isFlagSet(selectedRole.permissions, Permission.ADMINISTRATOR) && (
                  <p className="role-admin-note">Administrador concede todas as permissões — as demais opções abaixo ficam irrelevantes.</p>
                )}
                {groupedPermissions.map(([category, definitions]) => (
                  <div className="permission-group" key={category}>
                    <span className="field-eyebrow">{category}</span>
                    {definitions.map((definition) => (
                      <div className="permission-row" key={definition.flag}>
                        <span title={definition.description}>{definition.label}</span>
                        <button
                          type="button"
                          disabled={!canEditSelected}
                          className={`static-switch${isFlagSet(selectedRole.permissions, definition.flag) ? ' on' : ''}`}
                          onClick={() =>
                            void patchSelectedRole({
                              permissions: isFlagSet(selectedRole.permissions, definition.flag)
                                ? selectedRole.permissions & ~definition.flag
                                : selectedRole.permissions | definition.flag,
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}

            {tab === 'members' && (
              <>
                <div className="permissions-heading">
                  <div><h3>Gerenciar membros</h3><p>Escolha quem tem o cargo {selectedRole.name}.</p></div>
                  <label className="roles-search">
                    <SearchIcon size={14} />
                    <input placeholder="Buscar membro" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} />
                  </label>
                </div>
                {selectedRole.id === EVERYONE_ROLE_ID ? (
                  <p className="role-admin-note">Todo mundo tem @everyone automaticamente — não dá pra atribuir ou remover manualmente.</p>
                ) : (
                  <div className="role-member-list">
                    {filteredMembers.map((member) => {
                      const hasRole = member.roleIds.includes(selectedRole.id);
                      return (
                        <div className="permission-row" key={member.id}>
                          <span>{member.displayName}</span>
                          <button
                            type="button"
                            disabled={!canEditSelected}
                            className={`static-switch${hasRole ? ' on' : ''}`}
                            onClick={() => void toggleMemberInRole(member.id, hasRole)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        ) : (
          <section className="role-editor"><p>Selecione um cargo à esquerda.</p></section>
        )}
      </div>
    </div>
  );
}

type ModerationMenuState = { userId: string; mode: 'timeout' | 'ban' } | null;

const TIMEOUT_PRESETS = [
  { label: '5 minutos', minutes: 5 },
  { label: '10 minutos', minutes: 10 },
  { label: '1 hora', minutes: 60 },
  { label: '1 dia', minutes: 60 * 24 },
  { label: '7 dias', minutes: 60 * 24 * 7 },
];

function MembersPane({ session }: { session: UserSession }) {
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [bans, setBans] = useState<BanRecord[]>([]);
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<ModerationMenuState>(null);
  const [banReason, setBanReason] = useState('');
  const [feedback, setFeedback] = useState('');

  const canKick = hasPermission(session.permissions, Permission.KICK_MEMBERS);
  const canBan = hasPermission(session.permissions, Permission.BAN_MEMBERS);
  const canTimeout = hasPermission(session.permissions, Permission.MODERATE_MEMBERS);
  const ownPosition = useMemo(() => highestPosition(session.roleIds, roles), [session.roleIds, roles]);

  useEffect(() => {
    let active = true;
    void Promise.all([api.getMembers(), api.getRoles()]).then(([membersResult, rolesResult]) => {
      if (!active) return;
      setMembers(membersResult.members);
      setRoles(rolesResult.roles);
    });
    if (canBan) void api.getBans().then((result) => active && setBans(result.bans));
    const unsubscribe = onRealtimeEvent((event) => {
      if (event.type === 'MEMBER_ROLES_UPDATE') {
        setMembers((current) => current.map((member) => (member.id === event.userId ? { ...member, roleIds: event.roleIds } : member)));
      } else if (event.type === 'MEMBER_TIMEOUT_UPDATE') {
        setMembers((current) =>
          current.map((member) => (member.id === event.userId ? { ...member, timeoutUntil: event.timeoutUntil } : member)),
        );
      } else if (event.type === 'MEMBER_BANNED') {
        setMembers((current) => current.filter((member) => member.id !== event.userId));
      } else if (event.type === 'ROLE_CREATE') {
        setRoles((current) => [...current, event.role]);
      } else if (event.type === 'ROLE_UPDATE') {
        setRoles((current) => current.map((role) => (role.id === event.role.id ? event.role : role)));
      } else if (event.type === 'ROLE_DELETE') {
        setRoles((current) => current.filter((role) => role.id !== event.roleId));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [canBan]);

  function targetPosition(member: MemberSummary): number {
    return highestPosition(member.roleIds, roles);
  }

  function canModerate(member: MemberSummary): boolean {
    return member.id !== session.id && targetPosition(member) < ownPosition;
  }

  async function runAction(promise: Promise<unknown>, successMessage: string) {
    setFeedback('');
    try {
      await promise;
      setFeedback(successMessage);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Não foi possível concluir a ação.');
    }
  }

  const filtered = members.filter((member) => member.displayName.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="members-page">
      <div className="server-page-title">
        <div><h1>Membros</h1><p>Veja quem faz parte do servidor e aplique moderação quando necessário.</p></div>
      </div>
      <label className="roles-search members-search">
        <SearchIcon size={14} />
        <input placeholder="Buscar membro" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      {feedback && <p className="form-error" role="status">{feedback}</p>}
      <div className="member-roster">
        {filtered.map((member) => {
          const isTimedOut = Boolean(member.timeoutUntil && member.timeoutUntil > Date.now());
          const memberRoles = roles.filter((role) => role.id !== EVERYONE_ROLE_ID && member.roleIds.includes(role.id));
          const showMenu = menu?.userId === member.id;
          return (
            <div className="member-roster-row" key={member.id}>
              <div className="member-roster-identity">
                <span className="member-roster-name">{member.displayName}</span>
                <div className="member-roster-roles">
                  {memberRoles.map((role) => (
                    <span key={role.id} className="role-chip" style={{ borderColor: role.color, color: role.color }}>{role.name}</span>
                  ))}
                  {isTimedOut && member.timeoutUntil && (
                    <span className="role-chip role-chip-timeout">Silenciado até {formatTimeoutUntil(member.timeoutUntil)}</span>
                  )}
                </div>
              </div>
              {canModerate(member) && (canKick || canBan || canTimeout) && (
                <div className="member-roster-actions">
                  {canKick && (
                    <button
                      type="button"
                      className="secondary-pill"
                      onClick={() => void runAction(api.voiceKickMember(member.id), `${member.displayName} foi expulso da chamada de voz.`)}
                    >
                      Expulsar da voz
                    </button>
                  )}
                  {canTimeout && !isTimedOut && (
                    <button type="button" className="secondary-pill" onClick={() => setMenu({ userId: member.id, mode: 'timeout' })}>
                      Timeout
                    </button>
                  )}
                  {canTimeout && isTimedOut && (
                    <button
                      type="button"
                      className="secondary-pill"
                      onClick={() => void runAction(api.clearMemberTimeout(member.id), `Timeout de ${member.displayName} removido.`)}
                    >
                      Remover timeout
                    </button>
                  )}
                  {canBan && (
                    <button type="button" className="secondary-pill danger-pill" onClick={() => setMenu({ userId: member.id, mode: 'ban' })}>
                      Banir
                    </button>
                  )}
                </div>
              )}
              {showMenu && menu.mode === 'timeout' && (
                <div className="moderation-inline-menu">
                  {TIMEOUT_PRESETS.map((preset) => (
                    <button
                      key={preset.minutes}
                      type="button"
                      className="secondary-pill"
                      onClick={() => {
                        void runAction(api.timeoutMember(member.id, preset.minutes), `${member.displayName} está em timeout por ${preset.label}.`);
                        setMenu(null);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button type="button" className="secondary-pill" onClick={() => setMenu(null)}>Cancelar</button>
                </div>
              )}
              {showMenu && menu.mode === 'ban' && (
                <div className="moderation-inline-menu">
                  <input
                    placeholder="Motivo do banimento (opcional)"
                    value={banReason}
                    onChange={(event) => setBanReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className="violet-primary danger-pill"
                    onClick={() => {
                      void runAction(api.banMember(member.id, banReason), `${member.displayName} foi banido.`);
                      setMenu(null);
                      setBanReason('');
                    }}
                  >
                    Confirmar banimento
                  </button>
                  <button type="button" className="secondary-pill" onClick={() => setMenu(null)}>Cancelar</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canBan && bans.length > 0 && (
        <div className="banned-members-section">
          <span className="field-eyebrow">Membros banidos — {bans.length}</span>
          {bans.map((ban) => (
            <div className="member-roster-row" key={ban.userId}>
              <div className="member-roster-identity">
                <span className="member-roster-name">{ban.displayName}</span>
                <div className="member-roster-roles">
                  <span className="role-chip role-chip-timeout">{ban.reason || 'Sem motivo informado'}</span>
                  {ban.bannedByName && <span className="role-chip">banido por {ban.bannedByName}</span>}
                </div>
              </div>
              <div className="member-roster-actions">
                <button
                  type="button"
                  className="secondary-pill"
                  onClick={() => {
                    void runAction(api.unbanMember(ban.userId), `${ban.displayName} foi desbanido.`);
                    setBans((current) => current.filter((entry) => entry.userId !== ban.userId));
                  }}
                >
                  Desbanir
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

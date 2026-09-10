import { randomUUID } from 'node:crypto';
import { combinePermissions, EVERYONE_ROLE_ID, type AccentColor, type MemberSummary, type Role } from '@sausixudos/shared';
import { db } from './db.js';

interface RoleRow {
  id: string;
  name: string;
  color: string;
  position: number;
  hoist: number;
  permissions: number;
  created_at: number;
}

interface MemberRow {
  id: string;
  username: string;
  accent_color: AccentColor;
  avatar_data_url: string;
  status_text: string;
  timeout_until: number | null;
}

const listRolesStatement = db.prepare('SELECT * FROM roles ORDER BY position DESC, created_at ASC');
const selectRoleByIdStatement = db.prepare('SELECT * FROM roles WHERE id = ?');
const selectRoleByNameStatement = db.prepare('SELECT * FROM roles WHERE name = ? COLLATE NOCASE');
const insertRoleStatement = db.prepare(
  'INSERT INTO roles (id, name, color, position, hoist, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const updateRoleStatement = db.prepare(
  'UPDATE roles SET name = ?, color = ?, hoist = ?, permissions = ? WHERE id = ?',
);
const deleteRoleStatement = db.prepare("DELETE FROM roles WHERE id = ? AND id != 'everyone'");
const selectUserRoleIdsStatement = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?');
const insertUserRoleStatement = db.prepare(
  'INSERT OR IGNORE INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)',
);
const deleteUserRoleStatement = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?');
const selectUserPermissionsStatement = db.prepare(`
  SELECT roles.permissions AS permissions
  FROM user_roles
  INNER JOIN roles ON roles.id = user_roles.role_id
  WHERE user_roles.user_id = ?
`);
const selectUserHighestPositionStatement = db.prepare(`
  SELECT MAX(roles.position) AS position
  FROM user_roles
  INNER JOIN roles ON roles.id = user_roles.role_id
  WHERE user_roles.user_id = ?
`);
const listMembersStatement = db.prepare(`
  SELECT users.id, users.username, users.accent_color, users.avatar_data_url, users.status_text, users.timeout_until
  FROM users
  LEFT JOIN bans ON bans.user_id = users.id
  WHERE bans.user_id IS NULL
  ORDER BY users.username COLLATE NOCASE ASC
`);

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    hoist: Boolean(row.hoist),
    permissions: row.permissions,
    createdAt: row.created_at,
  };
}

export function listRoles(): Role[] {
  return (listRolesStatement.all() as unknown as RoleRow[]).map(toRole);
}

export function getRoleById(id: string): Role | undefined {
  const row = selectRoleByIdStatement.get(id) as unknown as RoleRow | undefined;
  return row && toRole(row);
}

export function getRoleByName(name: string): Role | undefined {
  const row = selectRoleByNameStatement.get(name) as unknown as RoleRow | undefined;
  return row && toRole(row);
}

export function getUserRoleIds(userId: string): string[] {
  return (selectUserRoleIdsStatement.all(userId) as { role_id: string }[]).map((row) => row.role_id);
}

// OR de tudo que o usuário tem direito por qualquer cargo atribuído — não há
// conceito de "deny" explícito (fora de escopo, ver DISCORD_PARITY_PLAN.md):
// um cargo só concede, nunca revoga o que outro já concedeu.
export function getUserPermissionBitfield(userId: string): number {
  const rows = selectUserPermissionsStatement.all(userId) as { permissions: number }[];
  return combinePermissions(...rows.map((row) => row.permissions));
}

// Usada pra decidir hierarquia (quem pode moderar/gerenciar cargos de quem).
// Quem não tem nenhum cargo além do implícito @everyone fica em 0.
export function getUserHighestPosition(userId: string): number {
  const row = selectUserHighestPositionStatement.get(userId) as { position: number | null } | undefined;
  return row?.position ?? 0;
}

export function assignDefaultRole(userId: string): void {
  insertUserRoleStatement.run(userId, EVERYONE_ROLE_ID, Date.now());
}

export function createRole(name: string, color: string, permissions: number, position: number, hoist: boolean): Role {
  const role: Role = { id: randomUUID(), name, color, position, hoist, permissions, createdAt: Date.now() };
  insertRoleStatement.run(role.id, role.name, role.color, role.position, role.hoist ? 1 : 0, role.permissions, role.createdAt);
  return role;
}

export type UpdateRoleResult = { ok: true; role: Role } | { ok: false; reason: 'NOT_FOUND' };

export function updateRole(
  id: string,
  patch: { name?: string | undefined; color?: string | undefined; permissions?: number | undefined; hoist?: boolean | undefined },
): UpdateRoleResult {
  const existing = getRoleById(id);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };

  // @everyone não pode ser renomeado nem "destacado" na lista de membros —
  // mas suas permissões e cor continuam editáveis (é assim que um admin
  // restringe o que todo mundo pode fazer por padrão).
  const isEveryone = id === EVERYONE_ROLE_ID;
  const next: Role = {
    ...existing,
    name: isEveryone ? existing.name : (patch.name ?? existing.name),
    color: patch.color ?? existing.color,
    hoist: isEveryone ? false : (patch.hoist ?? existing.hoist),
    permissions: patch.permissions ?? existing.permissions,
  };
  updateRoleStatement.run(next.name, next.color, next.hoist ? 1 : 0, next.permissions, id);
  return { ok: true, role: next };
}

export type DeleteRoleResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'IMMUTABLE' };

export function deleteRole(id: string): DeleteRoleResult {
  if (id === EVERYONE_ROLE_ID) return { ok: false, reason: 'IMMUTABLE' };
  if (!getRoleById(id)) return { ok: false, reason: 'NOT_FOUND' };
  deleteRoleStatement.run(id);
  return { ok: true };
}

export function assignRole(userId: string, roleId: string): void {
  insertUserRoleStatement.run(userId, roleId, Date.now());
}

export function unassignRole(userId: string, roleId: string): void {
  deleteUserRoleStatement.run(userId, roleId);
}

export function listMembers(): MemberSummary[] {
  const rows = listMembersStatement.all() as unknown as MemberRow[];
  return rows.map((row) => ({
    id: row.id,
    displayName: row.username,
    accentColor: row.accent_color,
    avatarUrl: row.avatar_data_url,
    statusText: row.status_text,
    roleIds: getUserRoleIds(row.id),
    timeoutUntil: row.timeout_until,
  }));
}

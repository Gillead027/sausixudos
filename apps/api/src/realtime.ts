import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RealtimeEvent } from '@sausixudos/shared';
import { config } from './config.js';
import { isBanned } from './moderation.js';
import { getSessionFromCookieHeader } from './session.js';
import { getUserById } from './users.js';

const REALTIME_PATH = '/api/realtime';
const HEARTBEAT_INTERVAL_MS = 30_000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
  userId?: string;
}

// Todo mundo autenticado vê o mesmo servidor/canais (não existe conceito de
// múltiplos servidores ainda — ver DISCORD_PARITY_PLAN.md), então broadcast()
// continua correto pra eventos de servidor. DMs/amizade, porém, precisam de
// envio direcionado (ver sendToUsers abaixo) — cada socket já carrega
// `userId` desde o handshake, então um Set simples com filtro linear resolve
// isso sem precisar de um Map indexado (escala de um grupo de amigos).
const clients = new Set<TrackedSocket>();

export function broadcast(event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// Manda um evento só pros usuários listados (ex.: os 2 participantes de um
// DM) — cobre múltiplas abas/dispositivos do mesmo usuário automaticamente,
// já que itera todos os sockets e filtra por userId, igual disconnectUser.
export function sendToUsers(userIds: readonly string[], event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.userId && userIds.includes(client.userId) && client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

export function sendToUser(userId: string, event: RealtimeEvent): void {
  sendToUsers([userId], event);
}

// Usado quando um usuário é banido — sem isso, o cookie continuaria válido
// até a próxima requisição HTTP dele; fechar a conexão de tempo real força o
// cliente a notar imediatamente (o cliente web trata o close reconectando e
// então recebe 401/403 do requireSession, que já limpa o cookie).
export function disconnectUser(userId: string): void {
  for (const client of clients) {
    if (client.userId === userId) client.close();
  }
}

export function attachRealtime(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url !== REALTIME_PATH) return;

    // Mesma política de origem já aplicada ao HTTP via cors({ origin: WEB_ORIGIN }).
    const origin = request.headers.origin;
    if (origin && origin !== config.WEB_ORIGIN) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const identity = getSessionFromCookieHeader(request.headers.cookie);
    const user = identity ? getUserById(identity.id) : undefined;
    if (!user || isBanned(user.id)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: TrackedSocket) => {
      ws.isAlive = true;
      ws.userId = user.id;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });
}

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RealtimeEvent } from '@sausixudos/shared';
import { config } from './config.js';
import { getSessionFromCookieHeader } from './session.js';
import { getUserById } from './users.js';

const REALTIME_PATH = '/api/realtime';
const HEARTBEAT_INTERVAL_MS = 30_000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

// Todo mundo autenticado vê o mesmo servidor/canais hoje (não existe conceito
// de múltiplos servidores/DMs ainda — ver DISCORD_PARITY_PLAN.md), então um
// Set simples de conexões é suficiente: não há necessidade de indexar por
// usuário enquanto nada precisa de envio direcionado a alguém específico.
const clients = new Set<TrackedSocket>();

export function broadcast(event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
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
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: TrackedSocket) => {
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });
}

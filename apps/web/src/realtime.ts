import type { RealtimeEvent } from '@sausixudos/shared';

type EventHandler = (event: RealtimeEvent) => void;
type ConnectHandler = () => void;

const eventHandlers = new Set<EventHandler>();
const connectHandlers = new Set<ConnectHandler>();

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

let socket: WebSocket | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function realtimeUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/realtime`;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

function open(): void {
  const ws = new WebSocket(realtimeUrl());
  socket = ws;

  ws.onopen = () => {
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    for (const handler of connectHandlers) handler();
  };
  ws.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data as string) as RealtimeEvent;
      for (const handler of eventHandlers) handler(event);
    } catch {
      // Evento malformado não deve derrubar a conexão inteira.
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

// Chamado uma vez, dentro de Workspace.tsx (a única tela de vida longa
// pós-login) — idempotente, chamadas repetidas não abrem conexões extras.
export function connectRealtime(): void {
  if (started) return;
  started = true;
  open();
}

// Cada consumidor assina o fluxo inteiro e filtra pelo próprio `event.type`/
// `channelId` de interesse — mais simples que um registro por tipo de
// evento, e só existem dois consumidores hoje (TextChannels, Workspace).
export function onRealtimeEvent(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => eventHandlers.delete(handler);
}

// Disparado sempre que uma conexão nova é estabelecida (a primeira vez e
// toda reconexão) — consumidores usam isso pra refazer o fetch inicial e
// resincronizar qualquer coisa perdida enquanto estavam offline.
export function onRealtimeConnect(handler: ConnectHandler): () => void {
  connectHandlers.add(handler);
  return () => connectHandlers.delete(handler);
}

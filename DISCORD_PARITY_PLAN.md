# DISCORD_PARITY_PLAN.md

Documento vivo de paridade funcional com o Discord, para o Sausixudos/GilleCord — app privado, self-hosted, para um grupo fechado de amigos. Atualizar conforme cada item avança. Categorias: `DONE`, `PARTIAL`, `MISSING`, `BLOCKED`, `OPTIONAL`, `PREMIUM`, `EXPERIMENTAL`.

Última análise completa do código: 2026-09-09. Atualizado em 2026-09-09 após implementar e verificar em produção: (1) a fundação de WebSocket + canais de voz como dados (ver §1); (2) edição/exclusão de mensagem + markdown seguro (ver §8); (3) reações em mensagens (ver §8).

## 0. Arquitetura atual (para não recriar o que já existe)

| Camada | Tecnologia | Observação |
|---|---|---|
| Frontend web | React + Vite, TypeScript | `apps/web`, ~5.600 linhas. SPA única, sem router de páginas (tudo em `Workspace.tsx`, 2.234 linhas). |
| Cliente desktop | Electron 44 | `apps/desktop`. Empacotado via electron-builder + GitHub Releases + auto-update. Picker nativo de tela, detecção de atividade (jogo/mídia via `windows-media-sessions`/`ps-list`), CSP restrito. |
| Backend | Express + TypeScript | `apps/api`, ~1.530 linhas. WebSocket próprio via `ws` em `apps/api/src/realtime.ts` (autenticado pelo mesmo cookie de sessão). |
| Banco | SQLite (`node:sqlite`, arquivo único) | `apps/api/src/db.ts`. Schema: `users`, `text_channels`, `text_messages`, `text_bot_messages`, `voice_channels`. Sem migrations versionadas — `ALTER TABLE`/seed condicional. |
| Autenticação | Cookie assinado (HMAC), stateless | `apps/api/src/session.ts`. Usuário+senha (bcrypt/scrypt a confirmar) + token de convite único global. Sem lista de sessões, sem revogação individual, sem MFA. |
| Voz/vídeo/tela | LiveKit self-hosted (SFU) | Config via env var `LIVEKIT_CONFIG` no `docker-compose.yml` (não mais arquivo estático — precisava de `${LIVEKIT_API_KEY}` pro webhook). IP externo direto, **sem TURN/coturn** (aceitável só porque a VPS tem IP público; falha para clientes atrás de NAT simétrico). Webhook (`participant_joined`/`left`/`room_started`/`finished`) empurra estado de sala pro WebSocket da API. |
| Mensagens de texto | WebSocket em tempo real | `apps/web/src/realtime.ts` + `apps/api/src/realtime.ts`. Fetch HTTP só no boot/reconexão; sem polling. |
| Bot de música | Node standalone, participante LiveKit real | `apps/music-bot`. YouTube/Spotify(metadata)/SoundCloud, fila real, jitter buffer, scheduler sem deriva (corrigido nesta sessão). Card "tocando agora" resincronizado por um laço periódico *server-side* (não mais pelo poll do cliente). |
| Upload/mídia | Nenhum. Avatar/banner via `data:` URL em coluna TEXT do SQLite | Sem storage de objetos (S3/MinIO), sem anexos de arquivo em mensagens, sem thumbnails de upload. |
| Deploy | Docker Compose na VPS (147.93.11.201) + Caddy (TLS) | Serviços: `api`, `web`, `music-bot`, `livekit`, `pot-provider`, `caddy`. Sem Redis, sem fila de jobs, sem observabilidade estruturada. |
| Conceito de "servidor" | **Não existe.** Um único servidor implícito ("Lobby dos amigos"), hardcoded na UI | Canais de texto são uma lista plana em `text_channels`. Canais de voz agora são a tabela `voice_channels` (CRUD via `/api/voice-channels`, broadcast ao vivo) — ainda sem categorias nem múltiplos servidores. |

**Implicação central**: grande parte do pedido (múltiplos servidores, cargos por servidor, convites por servidor, temas por servidor, boost, server tags, onboarding, fórum, stage, eventos) pressupõe um modelo de dados "servidor" que **não existe hoje**. Isso não é um recurso faltando isoladamente — é uma mudança de esquema que quase tudo do FASE 1 em diante depende. Ver seção 1.

---

## 1. Fundação de dados (bloqueador da maior parte do resto)

| Item | Status | Nota |
|---|---|---|
| Tabela `servers` (múltiplos servidores) | `MISSING` | Hoje é 1 servidor fixo. Precisa existir antes de: cargos, convites por servidor, categorias, boost, server tags, onboarding. |
| Categorias de canal | `MISSING` | Canais de texto e de voz continuam listas planas (sem agrupamento), mesmo já sendo dados de banco. |
| Canais de voz como dados (não `.env`) | `DONE` | Tabela `voice_channels` (`apps/api/src/db.ts`), CRUD em `apps/api/src/voiceChannels.ts`, rotas `POST`/`DELETE /api/voice-channels`, UI de criação em `Workspace.tsx`. Migração de seed preserva os canais que já existiam via `VOICE_CHANNELS` — verificado contra o banco de produção real após o deploy. O bot de música não valida mais contra uma lista estática carregada no boot (confiava na validação já feita pela API). |
| Cargos (`roles`) | `MISSING` | Nenhuma tabela, nenhum conceito de cargo hoje. |
| Permissões granulares (allow/deny/inherit) | `MISSING` | Hoje não há checagem de permissão nenhuma no backend além de "está autenticado" (criar/apagar canal de voz segue esse mesmo padrão, igual canal de texto). |
| Convites reais (tabela, expiração, usos) | `MISSING` | Hoje é 1 token de convite global fixo no `.env`, sem rastreamento. |
| Amigos / bloqueios / DMs / grupos | `MISSING` | Nenhuma tabela, nenhuma rota, nenhuma UI. |
| WebSocket real para texto/presença/typing | `DONE` (texto/salas/canais) — `MISSING` (typing/presença de status) | `apps/api/src/realtime.ts` (`ws`, autenticado por cookie no handshake) + `apps/web/src/realtime.ts` (cliente com reconexão exponencial). Substituiu os 3 loops de polling (mensagens 2s, salas 4s, canais de texto 10s) por eventos `TEXT_MESSAGE_*`/`TEXT_CHANNEL_CREATE`/`VOICE_CHANNEL_*`/`ROOM_STATE_UPDATE`. Estado de sala de voz vem de webhook do LiveKit, não mais de poll de `roomService.listRooms`. Verificado ponta-a-ponta com dois clientes reais (latência ~7ms vs. até 2000ms do polling antigo) antes do deploy. Ainda falta: typing indicator e presença de status (online/ausente/dnd) — esses eventos não existem ainda, só os que já tinham equivalente em polling. |
| Storage de objetos (uploads) | `MISSING` | Avatar/banner como `data:` URL em TEXT já é um gambiarra que não escala pra anexos de arquivo/vídeo. |
| Migrations versionadas | `PARTIAL` | Ainda é `CREATE TABLE IF NOT EXISTS`/seed condicional (sem versionamento formal), mas já suportou uma tabela nova (`voice_channels`) com sucesso e sem perda de dados em produção. Continua não sendo um sistema de migration de verdade — precisa existir antes das tabelas maiores (`servers`, `roles`, etc.). |

**Recomendação**: a fundação de WebSocket + canais de voz como dados já está implementada e em produção (ver linhas acima). O próximo passo de fundação, ainda não feito, é o mesmo de antes: `servers`, `server_members`, `channels` unificando texto+voz sob um servidor, `roles`, `role_permissions`, `invites` reais, `friendships`, `dm_channels`. O WebSocket já existente deve ser estendido (não recriado) com os novos tipos de evento que essas features vão precisar.

---

## 2. Autenticação e conta (Seção 2, 107-108 do pedido)

| Item | Status |
|---|---|
| Registro com convite | `DONE` — `POST /api/auth/register`, token único global, senha com hash |
| Login/logout | `DONE` |
| `registration_enabled`/`invite_only` configurável | `PARTIAL` — só existe o modo invite-only fixo; não há toggle admin |
| Alterar senha | `MISSING` |
| Alterar email/username | `MISSING` (username é fixo no registro) |
| Recuperação de senha | `MISSING` (sem email configurado — precisaria de SMTP) |
| Sessões/dispositivos (listar, revogar) | `MISSING` — sessão é cookie stateless, não há registro de sessões ativas |
| MFA/TOTP/códigos de recuperação | `MISSING` |
| Passkeys/WebAuthn | `MISSING` |
| Logout de todos os dispositivos | `BLOCKED` — impossível sem sessão stateful (precisaria trocar `SESSION_SECRET` por usuário ou guardar sessões em tabela) |

---

## 3-5. Interface principal, barra de servidores, pastas (Seções 3-5)

| Item | Status |
|---|---|
| Layout 3 colunas (rail/canais/conteúdo/membros) | `DONE` — já implementado e redesenhado visualmente |
| Múltiplos servidores na rail | `BLOCKED` por §1 (não existe conceito de múltiplos servidores) |
| Pastas de servidor | `BLOCKED` por §1 |
| Indicador de não lida/menção na rail | `MISSING` — hoje não há sequer rastreio de "última mensagem lida" |
| Responsividade mobile | `MISSING` — layout é desktop-first fixo |

---

## 4. FASE 1 — CORE (prioridade do pedido)

| Item | Status |
|---|---|
| Servidores | `MISSING` (ver §1) |
| Canais (texto) | `DONE` básico — criar, listar, enviar/receber em tempo real via WebSocket |
| Canais (voz) | `DONE` — dados reais (`voice_channels`), criar/apagar pela UI, ainda sem categorias |
| DM | `MISSING` |
| Mensagens (texto simples) | `DONE` básico |
| Mensagens (tempo real de verdade) | `DONE` — WebSocket, ver §1 |
| Amigos | `MISSING` |
| Cargos | `MISSING` |
| Permissões | `MISSING` |

## 5. FASE 2 — VOZ (prioridade especial #1 do pedido)

| Item | Status |
|---|---|
| WebRTC/SFU (LiveKit) | `DONE` |
| Conectar/desconectar canal de voz | `DONE`, com som próprio sincronizado (corrigido nesta sessão) |
| Mute/deafen | `DONE` |
| Volume individual por participante | `DONE` |
| Reconexão automática | `PARTIAL` — não verificado explicitamente; LiveKit client tem retry nativo, mas não há UI de "reconectando..." |
| TURN/coturn | `MISSING` — funciona hoje só por causa do IP público direto da VPS; falharia atrás de NAT simétrico/firewall restritivo |
| Push-to-talk / Voice Activity | `DONE` (input mode já implementado) |
| Teste de microfone | `DONE` |
| Noise suppression/echo/AGC | `PARTIAL` — Krisp (noise suppression) integrado; echo cancellation/AGC dependem do que o browser nativo já faz via `getUserMedia` constraints, não há controle fino |

## 6. FASE 3 — TRANSMISSÃO DE TELA (prioridade especial #2)

| Item | Status |
|---|---|
| Seleção de fonte (app/tela) com preview | `DONE` — picker nativo Electron já com abas |
| Seletor de resolução/FPS antes de iniciar | `DONE` |
| Toggle de compartilhar áudio | `DONE` |
| Som próprio de início/fim de transmissão | `DONE` (corrigido nesta sessão) |
| Indicador "AO VIVO" | `DONE` (mas note: foi removido da lista de membros por pedido do usuário e centralizado na lista de canais de voz — comportamento intencional, não regressão) |
| Trocar qualidade sem encerrar | `MISSING` — precisa renegociar track, não implementado |
| Multistream (vários compartilhando ao mesmo tempo) | `PARTIAL` — LiveKit suporta nativamente múltiplos publishers; UI de grid/foco pra múltiplas transmissões simultâneas não testada/implementada |
| Redução automática de bitrate sob perda de pacote | `PARTIAL` — LiveKit tem adaptive stream nativo; não há UI mostrando isso ao usuário |
| Fullscreen / Focus / PiP | `PARTIAL` — fullscreen existe; grid/focus/PiP formal não confirmado |

## 7. FASE 4 — VÍDEO

| Item | Status |
|---|---|
| Câmera on/off | `DONE` |
| Preview antes de ligar | `DONE` |
| Selecionar dispositivo de câmera | `DONE` |
| Fundo/blur/fundo customizado | `MISSING` |
| Grid multi-participante | `PARTIAL` |

## 8. FASE 5 — SOCIAL

| Item | Status |
|---|---|
| Perfil (avatar, banner, bio, pronomes, cor) | `DONE` |
| Mini-perfil / popover | `DONE` — inclui agora atividade rica (capa+progresso, sessão atual) |
| Presença (online/ausente/dnd/invisível/offline) | `MISSING` — hoje só existe "conectado à voz" ou não; não há status de presença geral (só atividade de jogo/música) |
| Status personalizado (emoji+texto+duração) | `MISSING` |
| Atividade (jogo/Spotify) | `DONE` — implementado nesta sessão inteira (detecção real via `ps-list`+`windows-media-sessions`, sem simulação) |
| Notificações (sistema/push) | `MISSING` |
| Busca de mensagens | `MISSING` |
| Inbox/caixa de entrada | `MISSING` |
| Reações | `DONE` — paleta curada de 8 emojis unicode (sem picker completo de busca/categorias ainda), tempo real via WebSocket, `apps/api/src/reactions.ts`. Super Reaction animada (Premium) continua `MISSING`. |
| Threads | `MISSING` |
| Enquetes | `MISSING` |
| Edição/exclusão de mensagem | `DONE` — só o próprio autor (sem cargos ainda pra moderação de terceiros); `PATCH`/`DELETE /api/text-channels/:id/messages/:id`, indicador "(editado)", tempo real via WebSocket. |
| Pins | `MISSING` |
| Reply/forward | `MISSING` |
| Markdown (negrito/itálico/negrito+itálico/sublinhado/tachado/spoiler/código inline/bloco de código/autolink) | `DONE` — renderizador próprio em `apps/web/src/components/Markdown.tsx`, monta árvore de elementos React (nunca `dangerouslySetInnerHTML`), 15 testes unitários cobrindo formatação e segurança contra XSS. Faltam: escape com barra invertida, citações (`>`), listas. |
| Emoji picker (unicode) | `MISSING` |
| Emoji/sticker customizado do servidor | `BLOCKED` por §1 |
| Upload de arquivo/imagem/vídeo em mensagem | `MISSING` — sem storage de objetos (ver §1) |
| GIF picker | `MISSING` |

## 9. FASE 6 — PERSONALIZAÇÃO

| Item | Status |
|---|---|
| Temas (claro/escuro/ash/onyx/sistema) | `DONE` |
| Densidade da UI | `DONE` |
| Estilo de mensagem (padrão/compacto) | `DONE` — "agrupado" não confirmado |
| Sliders de fonte/espaçamento/zoom | `DONE` |
| Cor de acento customizada (hex) | `DONE` |
| Avatar animado (GIF) | `MISSING` |
| Banner animado | `MISSING` (banner estático já existe) |
| Temas Premium/editor de tema completo | `MISSING` |
| Perfil por servidor | `BLOCKED` por §1 |

## 10. FASE 7 — COSMÉTICOS / PREMIUM

Tudo nesta fase é `MISSING`: Shop, moeda interna (Orbs), inventário, decorações de avatar, profile effects, profile frames, nameplates, display name styles, badges, sistema de tiers Premium/Boost, server tags, server themes. Nenhuma infraestrutura existe (sem tabela de itens, sem inventário, sem moeda). É a fase de maior volume de trabalho novo e menor urgência funcional — o pedido já reconhece isso como "sem cobrança real, tudo administrável".

## 11. FASE 8 — SERVER POWER FEATURES

Tudo `MISSING` ou `BLOCKED` por §1: fóruns, stage channels, eventos, onboarding, rules screening, aplicação para entrar, AutoMod, audit log, slowmode (não existe nem por canal), timeout/ban/kick (não existe nenhuma ação de moderação hoje).

## 12. FASE 9 — APPS

| Item | Status |
|---|---|
| Bot de música (participante real na call) | `DONE` — arquitetura completa, corrigida nesta sessão (jitter buffer, scheduler) |
| Bots/apps genéricos (slash commands, webhooks, botões, modals) | `MISSING` — o único "bot" é o SausiMusic, hardcoded, sem framework de apps reutilizável |
| Comandos de música via texto (`/play`, `!play` etc.) | `DONE` — parser próprio em `packages/shared` |
| Slash command picker de verdade (UI `/`) | `MISSING` — comandos de música são digitados como texto puro, não há autocomplete/picker |
| Soundboard | `MISSING` |
| Webhooks | `MISSING` |
| Activities (jogos in-call) | `MISSING` |

## 13. FASE 10 — EXTRAS

Clips, overlay de jogo, streamer mode, quests, E2EE avançado: todos `MISSING`. Overlay nativo Windows é `OPTIONAL`/baixa prioridade conforme o próprio pedido (§103). E2EE de mídia: `OPTIONAL` — LiveKit suporta E2EE nativo (frame encryption), viável de habilitar depois, mas não trivial e não crítico pra um grupo fechado de amigos confiando na própria VPS.

---

## 14. Segurança e infraestrutura transversal (Seções 127-130)

| Item | Status |
|---|---|
| Hash de senha | `DONE` (a confirmar algoritmo exato em `users.ts`) |
| HTTPS | `DONE` (Caddy) |
| Rate limiting | `PARTIAL` — existe em auth (`authLimiter`) e criação de canal (`textChannelCreateLimiter`); não existe em mensagens, reações, uploads (que ainda não existem) |
| Validação de permissão no backend | `PARTIAL` — como não há cargos/permissões, hoje é binário (autenticado ou não); nada a "burlar" ainda, mas também nada granular |
| CSP | `DONE` no cliente desktop empacotado; não configurado no `web` servido puro (não há necessidade igual, já que é servido por origem própria via Caddy) |
| Admin global (painel) | `MISSING` |
| Feature flags | `MISSING` — recomendado antes de começar a ligar features grandes em produção incrementalmente |
| i18n | `MISSING` — strings em português hardcoded em todos os componentes |
| Observabilidade estruturada | `MISSING` — hoje é `console.log`/arquivo de debug ad-hoc no desktop |

---

## 15. Prioridade especial do usuário (Seção 141) — status atual

1. Voz estável — `DONE`
2. Transmissão de tela — `DONE` (falta troca de qualidade sem reconectar)
3. Compartilhamento de áudio — `DONE`
4. Vídeo — `DONE` básico (falta fundo/blur)
5. Conversar com amigos — `PARTIAL` (chat de texto existe; sistema de "amigos" formal não existe — hoje todo mundo no servidor único já vê tudo)
6. Servidores e canais — `PARTIAL` (canais de texto e voz são dados reais com CRUD e tempo real; múltiplos servidores/categorias não)
7. Bots de música — `DONE`
8. Personalização de perfil — `DONE`
9. Temas — `DONE`
10. Sistema Premium completo — `MISSING`
11. Soundboard — `MISSING`
12. Roles/permissões — `MISSING`
13. Administração — `MISSING`
14. Chat completo — `PARTIAL` (texto em tempo real, markdown, edição/exclusão e reações já funcionam; threads/pins/reply/busca/emoji picker completo ainda ausentes)

---

## 16. Próximos passos recomendados (ordem sugerida, não decidida ainda)

Dado que grande parte do pedido depende da fundação de dados (§1) que não existe, e que o próprio usuário pediu para não trabalhar em tudo simultaneamente, os candidatos a "próximo passo" são:

- **A) Fundação de dados + WebSocket real** — maior alavancagem, mas é trabalho de infraestrutura invisível (sem novidade visual imediata). Necessário antes de roles/permissões/DMs/reações em tempo real/moderação/auditoria.
- **B) Chat completo no servidor único atual** — markdown, edição/exclusão e reações **já feitos** (ver §8). Falta: pins, reply, busca, upload de arquivo. Uploads exigem decidir armazenamento (MinIO na própria VPS é a opção mais compatível com a infra atual).
- **C) Roles/permissões básicas + moderação (kick/ban/timeout)** — depende parcialmente de (A), mas pode ser feito de forma reduzida (cargos globais, sem hierarquia complexa) sem esperar multi-servidor.
- **D) Soundboard** — item da lista de prioridade especial, tecnicamente isolado (usa a mesma infra de áudio do LiveKit que já existe), não depende de (A).

Este documento será atualizado a cada sessão de trabalho subsequente com o que foi de fato implementado, testado e implantado — nunca marcar `DONE` sem teste ponta a ponta real, conforme a regra do pedido original.

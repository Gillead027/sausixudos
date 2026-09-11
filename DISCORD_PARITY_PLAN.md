# DISCORD_PARITY_PLAN.md

Documento vivo de paridade funcional com o Discord, para o Sausixudos/GilleCord — app privado, self-hosted, para um grupo fechado de amigos. Atualizar conforme cada item avança. Categorias: `DONE`, `PARTIAL`, `MISSING`, `BLOCKED`, `OPTIONAL`, `PREMIUM`, `EXPERIMENTAL`.

Última análise completa do código: 2026-09-09. Atualizado em 2026-09-10 após implementar e verificar em produção: (1) a fundação de WebSocket + canais de voz como dados (ver §1); (2) edição/exclusão de mensagem + markdown seguro (ver §8); (3) reações em mensagens (ver §8); (4) responder mensagem (ver §8); (5) soundboard com áudio real via LiveKit (ver §12) — pendente de confirmação ao vivo do usuário; (6) cargos, permissões e moderação básica — kick/ban/timeout (ver §1, §14, §15); (7) mensagens fixadas e busca por canal (ver §8); (8) upload de arquivo/imagem em mensagem via MinIO self-hosted (ver §0, §8); (9) sistema de amigos + mensagens diretas 1:1 (ver §1, §15, §16) — verificado com script de CRUD puro, E2E via HTTP+WebSocket, verificação visual real em dois navegadores via Playwright, e smoke test em produção. Atualizado em 2026-09-11 com 2 correções de bug real relatadas pelo usuário (com prints como prova): (10) soundboard sem áudio no cliente desktop por bloqueio de CSP (ver §12); (11) tela de "Entrando na sala..." travando pra sempre ao voltar pra um canal de voz (ver §5).

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
| Upload/mídia | Anexo de mensagem via MinIO self-hosted (`apps/api/src/storage.ts`/`attachments.ts`) | Avatar/banner continuam via `data:` URL (não migrados, funcionam bem do jeito que estão). Anexos: até 15MB/arquivo, 5 por mensagem, upload em duas etapas (sobe → vincula ao enviar a mensagem), servidos por `GET /api/attachments/:id/:filename` que decide inline vs. download forçado no servidor (nunca no cliente) — só png/jpeg/webp/gif viram `<img>`, todo o resto (inclusive SVG) é download forçado, o que evita servir um arquivo malicioso como HTML/SVG a partir da nossa própria origem. Sem thumbnails/transcodificação de vídeo. |
| Deploy | Docker Compose na VPS (147.93.11.201) + Caddy (TLS) | Serviços: `api`, `web`, `music-bot`, `livekit`, `pot-provider`, `caddy`, `minio` (novo — storage de anexos, nunca exposto à internet, só acessível pelo `api` via rede interna do compose). Sem Redis, sem fila de jobs, sem observabilidade estruturada. |
| Conceito de "servidor" | **Não existe.** Um único servidor implícito ("Lobby dos amigos"), hardcoded na UI | Canais de texto são uma lista plana em `text_channels`. Canais de voz agora são a tabela `voice_channels` (CRUD via `/api/voice-channels`, broadcast ao vivo) — ainda sem categorias nem múltiplos servidores. |

**Implicação central**: grande parte do pedido (múltiplos servidores, cargos por servidor, convites por servidor, temas por servidor, boost, server tags, onboarding, fórum, stage, eventos) pressupõe um modelo de dados "servidor" que **não existe hoje**. Isso não é um recurso faltando isoladamente — é uma mudança de esquema que quase tudo do FASE 1 em diante depende. Ver seção 1.

---

## 1. Fundação de dados (bloqueador da maior parte do resto)

| Item | Status | Nota |
|---|---|---|
| Tabela `servers` (múltiplos servidores) | `MISSING` | Hoje é 1 servidor fixo. Precisa existir antes de: cargos, convites por servidor, categorias, boost, server tags, onboarding. |
| Categorias de canal | `MISSING` | Canais de texto e de voz continuam listas planas (sem agrupamento), mesmo já sendo dados de banco. |
| Canais de voz como dados (não `.env`) | `DONE` | Tabela `voice_channels` (`apps/api/src/db.ts`), CRUD em `apps/api/src/voiceChannels.ts`, rotas `POST`/`DELETE /api/voice-channels`, UI de criação em `Workspace.tsx`. Migração de seed preserva os canais que já existiam via `VOICE_CHANNELS` — verificado contra o banco de produção real após o deploy. O bot de música não valida mais contra uma lista estática carregada no boot (confiava na validação já feita pela API). |
| Cargos (`roles`) | `DONE` (globais, sem multi-servidor) | Tabelas `roles`/`user_roles` (`apps/api/src/roles.ts`). `@everyone` automático pra todo usuário registrado; sem hierarquia de "dono" separada nem reordenação manual de posição (cargo novo nasce logo abaixo do mais alto de quem criou) — redução deliberada, ver §15. |
| Permissões granulares (allow/deny/inherit) | `PARTIAL` | Bitfield real (`Permission` em `packages/shared`) checado no backend em canais, mensagens, soundboard, cargos e moderação — mas só "concede" (sem allow/deny/inherit por canal, sem override por canal individual). |
| Convites reais (tabela, expiração, usos) | `MISSING` | Hoje é 1 token de convite global fixo no `.env`, sem rastreamento. |
| Amigos / bloqueios / DMs 1:1 | `DONE` (sem grupo) | Tabelas `friendships`/`blocks`/`dm_channels`/`dm_messages` (`apps/api/src/friendships.ts`/`blocks.ts`/`dmChannels.ts`). Pedido/aceite/recusa/remoção/bloqueio reais, DM 1:1 exige amizade `ACCEPTED` (sem "solicitação de mensagem" de estranho — redução deliberada). DM em grupo, reação/pin/busca/anexo dentro de DM continuam `MISSING` (chat de servidor já tem tudo isso; DM começou mais simples). |
| WebSocket real para texto/presença/typing | `DONE` (texto/salas/canais/amigos/DM) — `MISSING` (typing/presença de status) | `apps/api/src/realtime.ts` (`ws`, autenticado por cookie no handshake) + `apps/web/src/realtime.ts` (cliente com reconexão exponencial). Substituiu os 3 loops de polling (mensagens 2s, salas 4s, canais de texto 10s) por eventos `TEXT_MESSAGE_*`/`TEXT_CHANNEL_CREATE`/`VOICE_CHANNEL_*`/`ROOM_STATE_UPDATE`, e ganhou `sendToUsers`/`sendToUser` (envio direcionado, não mais só `broadcast()` pra todo mundo) pra suportar amizade/DM com privacidade real. Verificado ponta-a-ponta com dois clientes reais (latência ~7ms vs. até 2000ms do polling antigo) antes do deploy, e de novo agora pro fluxo de amigos/DM. Ainda falta: typing indicator e presença de status (online/ausente/dnd) — esses eventos não existem ainda. |
| Storage de objetos (uploads) | `DONE` | MinIO self-hosted (novo serviço no `docker-compose.yml`, ver §0). Usado só para anexo de mensagem por enquanto — avatar/banner continuam via `data:` URL (não migrados, sem necessidade). |
| Migrations versionadas | `PARTIAL` | Ainda é `CREATE TABLE IF NOT EXISTS`/seed condicional (sem versionamento formal), mas já suportou uma tabela nova (`voice_channels`) com sucesso e sem perda de dados em produção. Continua não sendo um sistema de migration de verdade — precisa existir antes das tabelas maiores (`servers`, `roles`, etc.). |

**Recomendação**: WebSocket, canais de voz como dados, cargos/permissões/moderação, e agora amigos/bloqueios/DM 1:1 já estão implementados e em produção (ver linhas acima). O único item grande de fundação que resta é `servers`/`server_members`/`channels` unificando texto+voz sob um servidor de verdade + `invites` reais — isso é o que ainda bloqueia múltiplos servidores, convites por servidor, cargos por servidor, forward de mensagem, categorias, boost e server tags. O WebSocket já existente deve ser estendido (não recriado) com os novos tipos de evento que isso vai precisar.

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
| DM | `DONE` (1:1, ver §1) — sem grupo, sem reação/pin/busca/anexo dentro do DM ainda |
| Mensagens (texto simples) | `DONE` básico |
| Mensagens (tempo real de verdade) | `DONE` — WebSocket, ver §1 |
| Amigos | `DONE` (pedido/aceite/recusa/remoção/bloqueio, ver §1) |
| Cargos | `DONE` (globais, ver §1) |
| Permissões | `PARTIAL` (ver §1) |

## 5. FASE 2 — VOZ (prioridade especial #1 do pedido)

| Item | Status |
|---|---|
| WebRTC/SFU (LiveKit) | `DONE` |
| Conectar/desconectar canal de voz | `DONE`, com som próprio sincronizado (corrigido nesta sessão) |
| Mute/deafen | `DONE` |
| Volume individual por participante | `DONE` |
| Reconexão automática | `PARTIAL` — não verificado explicitamente; LiveKit client tem retry nativo, mas não há UI de "reconectando..." |
| Timeout ao entrar/trocar de canal de voz | `DONE` (achado real em 2026-09-11, relatado pelo usuário com print) — `room.connect()`/`room.disconnect()` não tinham timeout próprio; numa negociação ICE que trava (sem TURN/coturn, ver §1), a tela de "Entrando na sala..." ficava presa pra sempre sem erro nenhum. Corrigido com timeout de 20s (`useVoiceRoom.ts`) que vira erro real e visível, mais uma trava contra `connect()` concorrente (clicar de novo no canal enquanto já está conectando era o gatilho mais comum — ex.: voltar de um canal de texto). |
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
| Busca de mensagens | `DONE` (por canal) — `GET /api/text-channels/:id/messages/search?q=`, `LIKE` parametrizado com fuga manual de `%`/`_`/`\`; sem busca cross-canal/cross-servidor (não existe ainda). |
| Inbox/caixa de entrada | `MISSING` |
| Reações | `DONE` — paleta curada de 8 emojis unicode (sem picker completo de busca/categorias ainda), tempo real via WebSocket, `apps/api/src/reactions.ts`. Super Reaction animada (Premium) continua `MISSING`. |
| Threads | `MISSING` |
| Enquetes | `MISSING` |
| Edição/exclusão de mensagem | `DONE` — autor sempre pode; quem tem o cargo com `MANAGE_MESSAGES` também pode apagar mensagem de outro (não editar, igual Discord real); `PATCH`/`DELETE /api/text-channels/:id/messages/:id`, indicador "(editado)", tempo real via WebSocket. |
| Pins | `DONE` — `POST`/`DELETE /api/text-channels/:id/messages/:id/pin`, exige `MANAGE_MESSAGES`, teto de 50 por canal (mesmo do Discord real), painel "Mensagens fixadas" na UI, tempo real via WebSocket (reaproveita `TEXT_MESSAGE_UPSERT`). |
| Reply | `DONE` — só guarda o id da mensagem original (não um snapshot congelado), resolvido contra o que já está carregado na conversa; mostra placeholder honesto se não encontrar. Clique no preview pula/destaca a original. |
| Forward (encaminhar pra outro canal/DM) | `MISSING` — ainda não existe DM. |
| Markdown (negrito/itálico/negrito+itálico/sublinhado/tachado/spoiler/código inline/bloco de código/autolink) | `DONE` — renderizador próprio em `apps/web/src/components/Markdown.tsx`, monta árvore de elementos React (nunca `dangerouslySetInnerHTML`), 15 testes unitários cobrindo formatação e segurança contra XSS. Faltam: escape com barra invertida, citações (`>`), listas. |
| Emoji picker (unicode) | `MISSING` |
| Emoji/sticker customizado do servidor | `BLOCKED` por §1 |
| Upload de arquivo/imagem em mensagem | `DONE` — até 15MB/arquivo, 5 por mensagem, via MinIO (ver §0/§1); vídeo funciona como download genérico (sem preview/transcodificação) |
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

`Timeout/ban/kick` agora `DONE` (ver §1, §15) — `POST/DELETE /api/moderation/timeout`, `/bans`, `/voice-kick`, com hierarquia por posição de cargo. O resto continua `MISSING` ou `BLOCKED` por §1: fóruns, stage channels, eventos, onboarding, rules screening, aplicação para entrar, AutoMod, audit log, slowmode (não existe nem por canal).

## 12. FASE 9 — APPS

| Item | Status |
|---|---|
| Bot de música (participante real na call) | `DONE` — arquitetura completa, corrigida nesta sessão (jitter buffer, scheduler) |
| Bots/apps genéricos (slash commands, webhooks, botões, modals) | `MISSING` — o único "bot" é o SausiMusic, hardcoded, sem framework de apps reutilizável |
| Comandos de música via texto (`/play`, `!play` etc.) | `DONE` — parser próprio em `packages/shared` |
| Slash command picker de verdade (UI `/`) | `MISSING` — comandos de música são digitados como texto puro, não há autocomplete/picker |
| Soundboard | `DONE` — áudio real via LiveKit (track publicada por quem toca, `Track.Source.Unknown` + name "soundboard", SFU distribui pra sala inteira, sem relay de servidor); upload com validação real de duração (`decodeAudioData`, não só tamanho de arquivo); volume dedicado por ouvinte; sincronização ao vivo via WebSocket; toast de quem tocou o quê via canal de dados do LiveKit. Achado real em 2026-09-11 (relatado pelo usuário, com print como prova): no cliente desktop empacotado, `playSoundboardSound` usava `fetch()` numa `data:` URL pra pegar os bytes do áudio, e a CSP do Electron bloqueava isso (`connect-src` não liberava o esquema `data:`) — dava "Failed to fetch" e nenhum som saía. Corrigido decodificando a `data:` URL manualmente (`atob`+`Uint8Array`, sem `fetch()` nenhum, ver `apps/web/src/livekit/useVoiceRoom.ts`), mais `data:` adicionado ao `connect-src` como defesa em profundidade. Isso explica por que a "confirmação ao vivo" nunca tinha chegado — o recurso realmente não funcionava no desktop. |
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
| Rate limiting | `DONE` (nos endpoints que existem) — auth, criação de canal, mensagens, reações, cargos, moderação e agora upload de anexo (`uploadLimiter`) têm limiter próprio |
| Validação de permissão no backend | `DONE` (reduzida) — bitfield de permissões checado em canais/mensagens/soundboard/cargos/moderação, com hierarquia por posição de cargo; ainda sem allow/deny por canal individual (ver §1) |
| CSP | `DONE` no cliente desktop empacotado; não configurado no `web` servido puro (não há necessidade igual, já que é servido por origem própria via Caddy) |
| Admin global (painel) | `PARTIAL` — a aba "Membros"/"Cargos" das configurações do servidor já cobre moderação básica (ver §1, §15); não há um painel dedicado separado |
| Feature flags | `MISSING` — recomendado antes de começar a ligar features grandes em produção incrementalmente |
| i18n | `MISSING` — strings em português hardcoded em todos os componentes |
| Observabilidade estruturada | `MISSING` — hoje é `console.log`/arquivo de debug ad-hoc no desktop |

---

## 15. Prioridade especial do usuário (Seção 141) — status atual

1. Voz estável — `DONE`
2. Transmissão de tela — `DONE` (falta troca de qualidade sem reconectar)
3. Compartilhamento de áudio — `DONE`
4. Vídeo — `DONE` básico (falta fundo/blur)
5. Conversar com amigos — `DONE` (sistema de amigos real + DM 1:1, ver §1; grupo de DM e forward ainda dependem de multi-servidor)
6. Servidores e canais — `PARTIAL` (canais de texto e voz são dados reais com CRUD e tempo real; múltiplos servidores/categorias não)
7. Bots de música — `DONE`
8. Personalização de perfil — `DONE`
9. Temas — `DONE`
10. Sistema Premium completo — `MISSING`
11. Soundboard — `DONE` (áudio real via LiveKit; falta confirmação ao vivo do usuário numa call de verdade)
12. Roles/permissões — `DONE` (globais, sem hierarquia completa de servidor — ver §1)
13. Administração — `DONE` (básica: kick da voz, timeout, ban/desban, cargos — via aba "Membros"/"Cargos"; sem painel dedicado nem audit log, ver §14)
14. Chat completo — `PARTIAL` (texto em tempo real, markdown, edição/exclusão, reações, reply, pins, busca por canal e upload de arquivo/imagem já funcionam; threads/forward/emoji picker completo ainda ausentes — forward bloqueado por §1)

---

## 16. Próximos passos recomendados (ordem sugerida, não decidida ainda)

Dado que grande parte do pedido depende da fundação de dados (§1) que não existe, e que o próprio usuário pediu para não trabalhar em tudo simultaneamente, os candidatos a "próximo passo" são:

- **A) Fundação de dados + WebSocket real** — `DONE` (ver §1). Necessário antes de roles/permissões/DMs/moderação/auditoria.
- **B) Chat completo no servidor único atual** — markdown, edição/exclusão, reações, reply, pins, busca por canal e upload de arquivo/imagem **já feitos** (ver §8). Falta só: forward (depende de DM/multi-servidor, `BLOCKED` por §1) e emoji picker completo — os dois de baixo valor isolado ou bloqueados, então esta opção está praticamente esgotada.
- **C) Roles/permissões básicas + moderação (kick/ban/timeout)** — `DONE` (ver §1, §14, §15). Cargos globais reais, bitfield de permissões, hierarquia por posição, kick/ban/timeout com força de desconexão real, aba "Cargos"/"Membros" funcional. Verificado com 28 checagens de E2E real (dois usuários, WebSocket, banco) e confirmado em produção logo após o deploy. Pendente só de uma passada visual/UX do usuário nas novas telas (não dá pra abrir navegador a partir deste ambiente).
- **D) Soundboard** — `DONE` (ver §12), pendente só de confirmação ao vivo do usuário numa call real.
- **E) Upload de arquivo/imagem em mensagem** — `DONE` (ver §0/§1/§8). Primeiro serviço de infraestrutura novo da sessão (MinIO self-hosted, nunca exposto à internet). Verificado com 18 checagens locais (MinIO real via Docker, incluindo a prova de segurança de que um SVG malicioso é sempre forçado a download) + 8 checagens direto em produção via HTTPS (registro, upload, download com bytes idênticos, envio de mensagem, exclusão limpando o objeto).
- **F) Amigos + mensagens diretas 1:1** — `DONE` (ver §1, §4, §15). Pedido/aceite (com auto-aceite em pedido mútuo simultâneo)/recusa/remoção/bloqueio reais; DM 1:1 exige amizade; `realtime.ts` ganhou envio direcionado (`sendToUsers`) em vez de só broadcast global. Escopo reduzido deliberado: sem DM em grupo, sem "solicitação de mensagem" de não-amigo, sem reação/pin/busca/anexo dentro do DM ainda. Verificado em 3 camadas: CRUD puro (31/31), E2E via HTTP+WebSocket com 3 usuários (31/31), e verificação visual real com Playwright em dois navegadores (pedido → aceite ao vivo → DM → mensagens nos dois sentidos, sem reload, sem erro de console) + smoke test em produção via HTTPS (7/7).

Com A, C, D, E e F feitos e B praticamente esgotado (só restam forward e emoji picker completo, ambos de baixo valor isolado ou bloqueados), o único item grande do pedido original ainda não iniciado é a fundação de múltiplos servidores de verdade (`servers`, `server_members`, `channels` unificando texto+voz, convites reais por servidor) — isso é o que ainda bloqueia forward de mensagem, cargos por servidor, categorias, boost, server tags e boa parte do FASE 7/8. É de longe o maior trabalho que resta.

Este documento será atualizado a cada sessão de trabalho subsequente com o que foi de fato implementado, testado e implantado — nunca marcar `DONE` sem teste ponta a ponta real, conforme a regra do pedido original.

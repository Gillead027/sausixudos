# Auditoria do pipeline de voz para o SausiMusic

## Escopo e arquitetura encontrada

O repositório é um monorepo npm. `apps/web` contém a aplicação React;
`apps/desktop` é um shell Electron que carrega essa mesma aplicação;
`apps/api` concentra autenticação, usuários, canais e emissão de credenciais;
`apps/music-bot` é um processo server-side separado; `packages/shared` contém
os contratos comuns. Não existe outro repositório ou cliente musical local.

O sistema atual possui um servidor implícito. Os canais de voz são definidos
por `VOICE_CHANNELS`; cada `VoiceChannel.id` é usado diretamente como nome da
room LiveKit. Ainda não há modelos backend de múltiplos servidores, memberships,
cargos ou permissões de domínio. As permissões existentes no desktop são as
permissões locais do Chromium/Electron para microfone, câmera e captura de tela.

## Autenticação e identidade

A autenticação da aplicação usa usuário persistido em SQLite e cookie de sessão
assinado, `HttpOnly` e `SameSite=Strict`. Rotas de voz e música passam pelo
middleware `requireSession`, que resolve novamente o usuário canônico pelo ID.

Para entrar em voz, o cliente solicita `POST /api/livekit/token` com um channel
ID. A API aceita apenas IDs presentes na configuração compartilhada e emite um
JWT curto com `roomJoin`, `canPublish`, `canSubscribe` e `canPublishData`. A
identity LiveKit do humano é o ID persistido do usuário. A metadata contém
`participantType: HUMAN` e o `userId` canônico.

O SausiMusic cria seu JWT apenas no processo server-side, usando a chave e o
secret LiveKit que nunca chegam ao navegador ou Electron. Sua identity é
`music-bot`, seu nome é `SausiMusic`, e sua metadata contém
`participantType: BOT` e `botId: music-bot`. A UI usa metadata/ID canônico, não
o nome visual, para mostrar o badge `BOT`.

## Entrada de um humano na call

1. O usuário autenticado escolhe um `VoiceChannel`.
2. `useVoiceRoom.connect()` pede à API um token limitado ao channel ID.
3. A API converte channel em room sem transformação: `roomName === channel.id`.
4. O cliente conecta ao endpoint de sinalização LiveKit com `autoSubscribe`.
5. Depois da conexão, publica o microfone por `setMicrophoneEnabled(true)`.
6. Participantes locais e remotos são lidos da própria `Room` do LiveKit.

## Voice state

Não existe uma tabela ou socket paralelo de voice state. A presença na room do
LiveKit é a fonte de verdade. A API consulta `RoomServiceClient.listParticipants`
para montar os resumos de sala e, antes de aceitar um comando musical, exige que
a identity canônica da sessão apareça na mesma room solicitada. Isso impede um
cliente de escolher uma room configurada na qual não está conectado.

## Publicação e distribuição de áudio humano

O cliente captura o microfone no navegador/Electron e o publica como track
LiveKit. A sinalização passa por HTTP/WebSocket na porta 7880 (via `/livekit`);
a mídia usa WebRTC para o SFU LiveKit, preferencialmente UDP 7882 e com fallback
TCP 7881. O codec de áudio é negociado pela stack WebRTC/LiveKit (Opus); o app
não transporta PCM pelo WebSocket da aplicação.

O SFU distribui as tracks aos demais participantes. `RemoteAudioSink` percorre
as publicações remotas de microfone e tela, anexa cada `RemoteAudioTrack` a um
elemento de áudio e aplica o volume local já existente. A track do SausiMusic
segue exatamente o mesmo caminho de uma track de microfone remota.

## Publicação do SausiMusic

Os comandos musicais com prefixo `/` ou `!` são normalizados pelo parser compartilhado.
A API valida sessão, comando, channel e voice state, então encaminha pela rede
interna apenas `{ channelId, command, args normalizados, requestedBy canônico }`.

`MusicSessionManager` mantém no máximo uma sessão por room. O
`BotVoiceParticipant` conecta com o token BOT, cria um `AudioSource` e uma
`LocalAudioTrack` marcada como `SOURCE_MICROPHONE`, e a publica na room.
`ProgrammaticAudioSource` gera um fixture de seis segundos diretamente em PCM
S16, mono, 48 kHz, com 960 amostras por canal em cada frame de 20 ms. A SDK
LiveKit recebe os frames, codifica a mídia no transporte WebRTC e o SFU a entrega
a todos os subscribers. DTX fica desligado para o tom não ser suprimido.

Cada room possui uma `MusicSession` independente com faixa atual, fila FIFO,
volume e handle do playback. Pause bloqueia a geração antes do próximo frame e
preserva o índice/posição; resume acorda a mesma task. O ganho 0–100 é aplicado
sample a sample antes de `captureFrame`. Término natural e skip avançam a fila;
stop e leave invalidam a geração atual e nunca executam auto-next.

O speaking não é simulado. O cliente reage a `RoomEvent.ActiveSpeakersChanged`,
emitido a partir do áudio efetivamente transportado. Ao fim natural ou em
`stop`, a track é removida e os recursos `AudioSource`/`LocalAudioTrack` são
fechados, portanto o LiveKit deixa de marcar o participante como ativo.

## Saída, cleanup e reconnect

Ao sair, o humano chama `Room.disconnect()`; os estados React de canal,
participantes, mensagens e speakers são limpos. O SDK LiveKit gerencia tentativas
de reconnect da conexão durante interrupções transitórias e emite os estados
`Reconnecting`/`Reconnected`; a UI expõe `ConnectionState.Reconnecting`.

No SausiMusic, `/stop` aborta a geração, limpa o buffer, unpublishes a track e
mantém o participante/sessão. `/leave` também desconecta o participante e remove
a sessão. O mesmo cleanup ocorre quando o último humano sai, quando a conexão do
bot é encerrada inesperadamente ou quando o worker recebe `SIGINT`/`SIGTERM`.
Erros de captura/publicação levam a sessão para `ERROR` e liberam a track.

## Chat e comandos

O chat de voz usa data packets confiáveis do próprio LiveKit no tópico
`sausixudos-chat`. Ele não é o transporte de áudio. Mensagens comuns continuam
nesse data channel; comandos musicais são command-only e seguem somente para a
API HTTP, que devolve feedback textual. O parser reconhece `play-file`, `pause`,
`resume`, `skip`, `stop`, `leave`, `queue`, `nowplaying`/`np`, `volume` e `clear`.

## Banco e persistência

SQLite persiste usuários, perfis, canais e mensagens de texto. Estado do player,
fila e volume permanecem intencionalmente em memória por room. Providers externos,
persistência musical, autoplay, múltiplos servidores, cargos e permissões avançadas
ficam fora deste marco.

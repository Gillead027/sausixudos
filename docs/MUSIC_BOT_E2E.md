# Validação manual E2E do player stateful do SausiMusic

Este roteiro valida audição, respostas textuais e transições do player em dois
clientes humanos. As fontes continuam sendo apenas tons determinísticos de seis
segundos gerados pelo processo `apps/music-bot`.

## Preparação local

Na raiz do monorepo, confirme que `.env` contém as mesmas chaves usadas pelo
LiveKit e execute:

```powershell
docker compose up -d livekit
docker compose ps livekit
npm install
npm run desktop:dev
```

O LiveKit deve aparecer como `healthy`. O comando `desktop:dev` inicia API, web,
SausiMusic e Electron como processos separados. Use o Electron como cliente A e
uma janela anônima em `http://localhost:5173` como cliente B.

## Cenário obrigatório

1. Entre como `Gillezin` no cliente A e como usuário de teste no cliente B.
2. Conecte ambos ao canal de voz `Geral` e abra o chat da call.
3. Envie `/play-file`; confirme que `Test Tone #1` começa, o bot aparece com
   badge `BOT`, ambos ouvem o tom e o speaking fica ativo.
4. Enquanto a primeira faixa toca, envie `/play-file` duas vezes. As respostas
   devem informar que `Test Tone #2` e `Test Tone #3` foram enfileiradas.
5. Envie `/queue`; confirme `Test Tone #1` como atual e `#2`, `#3` em ordem FIFO.
6. Envie `/pause`; o som e o speaking devem cessar nos dois clientes. Aguarde
   aproximadamente dois segundos.
7. Envie `/nowplaying`; confirme estado `PAUSED` e anote a posição.
8. Envie `/resume`; o som deve continuar do ponto pausado, sem reiniciar a faixa.
9. Envie `/volume 25`; confirme que o tom fica claramente mais baixo nos dois
   clientes. Envie `/volume 100` e confirme o retorno à amplitude normal.
10. Envie `/skip`; a faixa atual deve encerrar e a próxima começar sem criar um
    segundo participante SausiMusic.
11. Envie `/np`; confirme a nova faixa atual, posição, estado e volume.
12. Envie `/clear`; depois `/queue`. A faixa atual deve continuar e a fila futura
    deve aparecer vazia.
13. Envie `/stop`; o som deve parar, a fila deve ficar vazia e o bot deve continuar
    conectado na room.
14. Envie `/play-file`; confirme que uma nova faixa começa na mesma sessão.
15. Envie `/leave`; o áudio deve parar e o SausiMusic deve desaparecer dos dois
    clientes em realtime.

Todos os comandos acima também devem aceitar o prefixo `!`; `/nowplaying` também
possui os aliases `/np` e `!np`.

## Healthcheck

Durante a sessão, em outro PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:4100/health
```

Com uma sessão em `Geral`, `activeSessions` deve ser `1`. Depois de `/leave`, deve
voltar a `0`. O healthcheck não depende de existir uma faixa tocando.

## Evidência esperada

Preserve as linhas iniciadas por `[API]` e `[MUSIC]`. Conforme os comandos, a
sequência deve incluir:

```text
[API] music command authorized
[MUSIC] track queued
[MUSIC] playback started
[MUSIC] playback paused
[MUSIC] playback resumed
[MUSIC] volume changed
[MUSIC] playback skipped
[MUSIC] advancing queue
[MUSIC] queue cleared
[MUSIC] playback stopped
[MUSIC] session left
```

Se algum cliente não ouvir, confirme que “Liberar reprodução de áudio” não está
visível e que o cliente não está ensurdecido. Não copie tokens ou secrets ao
registrar logs.

# Sausixudos

MVP privado e self-hosted para voz, compartilhamento de tela e chat entre pequenos grupos.

## Arquitetura de produção

```text
Chrome / Edge
  |-- HTTPS /             -> Caddy -> web:80
  |-- HTTPS /api/*        -> Caddy -> api:3000
  |-- WSS /livekit/*      -> Caddy -> livekit:7880
  `-- WebRTC              -> VPS:7882/UDP (preferencial)
                              VPS:7881/TCP (fallback)
```

Somente Caddy (`80/TCP` e `443/TCP`) e a mídia LiveKit (`7881/TCP` e `7882/UDP`) publicam portas no host. Frontend, API e sinalização `7880/TCP` permanecem na rede interna do Compose.

O Compose usa `APP_DOMAIN` como fonte única e deriva estas URLs:

- aplicação: `https://APP_DOMAIN`;
- API: `https://APP_DOMAIN/api`;
- LiveKit WebSocket: `wss://APP_DOMAIN/livekit`.

O Caddy preserva `/api/*` para o Express. Em `/livekit/*`, `handle_path` remove o prefixo antes de encaminhar a conexão ao LiveKit; o `reverse_proxy` do Caddy suporta o upgrade WebSocket automaticamente.

## Segurança do deploy

- `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` são fornecidos somente aos containers `api` e `livekit`.
- O frontend recebe da API apenas a URL pública do LiveKit e um token de participante curto, limitado à sala.
- A sessão usa cookie `HttpOnly`, `Secure`, `SameSite=Strict`, host-only e `Path=/`.
- Frontend e API usam o mesmo domínio. O CORS aceita somente `https://APP_DOMAIN`.
- O convite não é armazenado pelo frontend.

## Verificações locais do código

```bash
npm install
npm run build
npm run typecheck
```

## Cliente Windows

O cliente Electron reutiliza a aplicação React servida pelo Sausixudos. Ele não
contém credenciais do LiveKit: autenticação, token de participante e configuração
de mídia continuam sendo fornecidos pela API do servidor.

Para desenvolvimento no Windows, mantenha no `.env` as mesmas variáveis usadas
pelo ambiente web e execute na raiz do projeto:

```powershell
npm install
npm run desktop:dev
```

O comando pressupõe que o LiveKit local existente esteja acessível em
`http://localhost:7880`; a conexão pública passa pelo proxy `/livekit` do Vite.
Resultado esperado: API, Vite e Electron iniciam juntos; uma única janela
Sausixudos abre `http://localhost:5173`. Fechar a janela encerra os três processos.

Para gerar os executáveis de produção, a URL precisa ser uma origem HTTPS. O
empacotador lê `APP_DOMAIN` do `.env` da raiz ou, quando definido, usa
`SAUSIXUDOS_APP_URL`:

```powershell
$env:SAUSIXUDOS_APP_URL = 'https://DOMINIO_DO_SAUSIXUDOS'
npm run desktop:build
Remove-Item Env:SAUSIXUDOS_APP_URL
```

Resultado esperado:

- instalador: `apps/desktop/release/Sausixudos-Setup.exe`;
- versão portátil: `apps/desktop/release/Sausixudos.exe`.

O instalador cria atalhos na área de trabalho e no menu Iniciar. O cliente não
exige Node.js, Docker ou navegador externo no computador de destino. Nesta etapa
os executáveis não possuem assinatura de código; por isso, o Windows pode exibir
um aviso do SmartScreen.

## Deploy na VPS

Os comandos abaixo assumem Ubuntu 22.04, 24.04 ou 26.04 de 64 bits e um usuário com `sudo`.

### 1. Preparar DNS

Antes de iniciar o Caddy, crie um registro DNS `A` apontando o domínio para o IPv4 público da VPS. Crie `AAAA` somente se a VPS tiver IPv6 público funcional. Aguarde até:

```bash
getent ahosts DOMINIO_DO_SAUSIXUDOS
```

Resultado esperado: o IP público da VPS aparece na saída.

### 2. Atualizar o Ubuntu

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git openssl ufw
```

Resultado esperado: sistema atualizado e comandos auxiliares instalados. Reinicie a VPS antes de continuar se o Ubuntu informar que um reboot é necessário.

### 3. Instalar Docker Engine e Compose plugin

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world
docker compose version
```

Resultado esperado: `hello-world` termina com sucesso e `docker compose version` mostra Compose v2. O grupo `docker` concede privilégios equivalentes a root; mantenha nele apenas administradores da VPS.

### 4. Configurar UFW

Permita SSH antes de habilitar o firewall para não perder acesso:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp comment 'Sausixudos HTTP ACME'
sudo ufw allow 443/tcp comment 'Sausixudos HTTPS WSS'
sudo ufw allow 7881/tcp comment 'Sausixudos LiveKit ICE TCP'
sudo ufw allow 7882/udp comment 'Sausixudos LiveKit ICE UDP'
sudo ufw enable
sudo ufw status verbose
```

Resultado esperado: apenas SSH e as quatro portas do Sausixudos aparecem como permitidas. Se o SSH usa uma porta personalizada, permita essa porta antes de `ufw enable`.

Docker pode encaminhar portas publicadas antes das regras normais do UFW. Por isso, replique as mesmas quatro permissões no firewall/security group do provedor da VPS. O Compose não publica nenhuma outra porta.

### 5. Copiar o projeto

Com repositório Git:

```bash
sudo install -d -o "$USER" -g "$USER" /opt/sausixudos
git clone URL_DO_REPOSITORIO /opt/sausixudos
cd /opt/sausixudos
```

Ou, a partir do computador local, empacote e envie todos os arquivos, incluindo `.env.example`:

```bash
tar -C CAMINHO_LOCAL_DO_SAUSIXUDOS -czf sausixudos.tar.gz .
scp sausixudos.tar.gz usuario@IP_DA_VPS:/tmp/sausixudos.tar.gz
```

Então, na VPS:

```bash
ssh usuario@IP_DA_VPS
sudo install -d -o "$USER" -g "$USER" /opt/sausixudos
tar -xzf /tmp/sausixudos.tar.gz -C /opt/sausixudos
cd /opt/sausixudos
```

Resultado esperado:

```bash
test -f docker-compose.yml && test -f infra/Caddyfile && test -f infra/livekit.yaml && echo "Projeto OK"
```

### 6. Criar o `.env`

```bash
cd /opt/sausixudos
cp .env.example .env

GC_INVITE_TOKEN="$(openssl rand -hex 24)"
GC_SESSION_SECRET="$(openssl rand -hex 32)"
GC_LIVEKIT_KEY="$(openssl rand -hex 16)"
GC_LIVEKIT_SECRET="$(openssl rand -hex 32)"

sed -i "s|^APP_DOMAIN=.*|APP_DOMAIN=DOMINIO_DO_SAUSIXUDOS|" .env
sed -i "s|^INVITE_TOKEN=.*|INVITE_TOKEN=$GC_INVITE_TOKEN|" .env
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$GC_SESSION_SECRET|" .env
sed -i "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=$GC_LIVEKIT_KEY|" .env
sed -i "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$GC_LIVEKIT_SECRET|" .env

unset GC_INVITE_TOKEN GC_SESSION_SECRET GC_LIVEKIT_KEY GC_LIVEKIT_SECRET
chmod 600 .env
nano .env
```

Substitua `DOMINIO_DO_SAUSIXUDOS` pelo hostname real, sem `https://` e sem `/`. No editor, anote o `INVITE_TOKEN` para fornecer aos dois participantes e confirme os canais.

Resultado esperado:

```bash
grep -E '^(APP_DOMAIN|VOICE_CHANNELS)=' .env
stat -c '%a %n' .env
```

O domínio correto deve aparecer e a permissão deve ser `600`.

### 7. Validar e subir os containers

```bash
cd /opt/sausixudos
docker compose config --quiet
docker compose pull
docker compose up -d --build
docker compose ps
```

Resultado esperado: `docker compose config --quiet` não imprime erros; depois do período inicial, `web`, `api`, `livekit` e `caddy` aparecem `Up` e `healthy`.

Se algum serviço ainda mostrar `health: starting`, aguarde alguns segundos:

```bash
watch -n 2 docker compose ps
```

Use `Ctrl+C` quando todos estiverem saudáveis.

### 8. Confirmar HTTPS e a API

```bash
curl -I https://DOMINIO_DO_SAUSIXUDOS/
curl -fsS https://DOMINIO_DO_SAUSIXUDOS/api/health
```

Resultado esperado: a primeira resposta é HTTP `200` e a segunda imprime `{"status":"ok"}`. O navegador deve mostrar certificado HTTPS válido.

## Diagnóstico do primeiro deploy

Estado e logs:

```bash
cd /opt/sausixudos
docker compose ps
docker compose logs --tail=200
docker compose logs --tail=200 livekit
docker compose logs --tail=200 api
docker compose logs --tail=200 caddy
docker compose logs -f livekit api caddy
```

Portas TCP/UDP no host:

```bash
sudo ss -lntp | grep -E ':(80|443|7881)\b'
sudo ss -lunp | grep -E ':7882\b'
sudo ufw status verbose
docker compose port livekit 7881
docker compose port livekit 7882
```

Resultado esperado: listeners TCP em `80`, `443` e `7881`, e UDP em `7882`. A porta interna `7880` não deve aparecer publicada no host.

Para observar mídia UDP durante a chamada:

```bash
sudo apt install -y tcpdump
sudo tcpdump -ni any udp port 7882
```

Pacotes devem aparecer quando usuários estiverem falando ou compartilhando tela. Encerre com `Ctrl+C`.

Erros comuns:

- certificado não emitido: confirme DNS, portas 80/443 e logs do Caddy;
- interface abre, mas voz não conecta: confirme `7882/UDP`, `7881/TCP` e o IP externo informado nos logs do LiveKit;
- `401` ao entrar: confirme o `INVITE_TOKEN` usado;
- LiveKit reiniciando: confirme que API key/secret são iguais nos containers e que o secret tem pelo menos 32 caracteres.

## Teste com dois computadores e duas redes

1. Deixe estes comandos abertos na VPS:

   ```bash
   cd /opt/sausixudos
   docker compose logs -f livekit api caddy
   ```

   Em outro terminal:

   ```bash
   sudo tcpdump -ni any udp port 7882
   ```

2. No computador A, conectado à rede residencial, abra `https://DOMINIO_DO_SAUSIXUDOS` no Chrome/Edge, confirme o certificado, entre com um nome e o convite e selecione o canal **Geral**.
3. No computador B, use outra rede, por exemplo hotspot móvel. Abra a mesma URL, use outro nome e o mesmo convite e entre no mesmo canal.
4. Aceite a permissão de microfone nos dois computadores. Confirme que ambos aparecem na sala e que o indicador de fala reage.
5. Fale A -> B e B -> A. Teste mute, deafen e o volume individual.
6. No computador A, selecione 720p30 e compartilhe uma aba ou tela. Para áudio, marque **Compartilhar áudio da guia/sistema** quando o Chrome/Edge oferecer essa opção.
7. No computador B, confirme vídeo, áudio compartilhado e tela cheia. Repita com 720p60 e 1080p60 somente depois do teste básico.
8. Em `chrome://webrtc-internals`, abra a conexão ativa e confirme que o par ICE selecionado usa protocolo UDP e porta remota `7882`. O `tcpdump` da VPS também deve mostrar tráfego.
9. Para comprovar o fallback TCP, execute como administrador no PowerShell de apenas um dos computadores Windows:

   ```powershell
   New-NetFirewallRule -DisplayName "Sausixudos UDP fallback test" -Direction Outbound -Protocol UDP -RemotePort 7882 -Action Block
   ```

   Saia e entre novamente no canal. Voz e tela devem continuar funcionando; `chrome://webrtc-internals` deve indicar TCP e a VPS deve receber conexão em `7881/TCP`.
10. Remova imediatamente a regra de teste:

   ```powershell
   Remove-NetFirewallRule -DisplayName "Sausixudos UDP fallback test"
   ```

11. O teste está aprovado quando voz bidirecional, controles, tela e áudio de compartilhamento funcionam em UDP, e a reconexão funciona por TCP com UDP bloqueado no cliente.

TURN permanece desabilitado nesta etapa. Redes que bloqueiam tanto UDP direto quanto ICE/TCP em `7881` não conseguirão conectar até uma futura configuração de TURN.

## Referências operacionais

- [Instalação oficial do Docker Engine no Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Portas e firewall do LiveKit](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [Deploy self-hosted do LiveKit](https://docs.livekit.io/transport/self-hosting/deployment/)
- [Reverse proxy do Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

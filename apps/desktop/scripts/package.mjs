import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDirectory = path.resolve(desktopDirectory, '../..');

async function resolveAppUrl() {
  if (process.env.SAUSIXUDOS_APP_URL) return process.env.SAUSIXUDOS_APP_URL;

  try {
    const envFile = await readFile(path.join(rootDirectory, '.env'), 'utf8');
    const domain = envFile
      .split(/\r?\n/)
      .find((line) => line.startsWith('APP_DOMAIN='))
      ?.slice('APP_DOMAIN='.length)
      .trim();
    if (domain) return `https://${domain}`;
  } catch {
    // A mensagem abaixo orienta a configuração quando não há .env.
  }

  throw new Error('Defina SAUSIXUDOS_APP_URL=https://seu-dominio ou APP_DOMAIN no .env da raiz.');
}

const appUrl = new URL(await resolveAppUrl());
if (appUrl.protocol !== 'https:' || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) {
  throw new Error('A URL de produção deve usar HTTPS e conter somente a origem, sem caminho ou parâmetros.');
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Execute o empacotamento pelo script npm run desktop:build.');

const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
  cwd: desktopDirectory,
  stdio: 'inherit',
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

await writeFile(
  path.join(desktopDirectory, 'dist', 'desktop-config.json'),
  `${JSON.stringify({ appUrl: appUrl.origin }, null, 2)}\n`,
  'utf8',
);

const require = createRequire(import.meta.url);
const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const builder = spawnSync(process.execPath, [builderCli, '--win', '--x64'], {
  cwd: desktopDirectory,
  stdio: 'inherit',
});
if (builder.error) throw builder.error;
process.exit(builder.status ?? 1);

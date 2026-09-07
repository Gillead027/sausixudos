import electron from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = {
  ...process.env,
  SAUSIXUDOS_APP_URL: 'http://localhost:5173',
};

// Alguns terminais de automação definem esta variável para executar Electron
// como Node. O cliente gráfico sempre precisa iniciar no modo normal.
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], {
  cwd: desktopDirectory,
  env: environment,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error('Não foi possível iniciar o Electron:', error);
  process.exitCode = 1;
});

child.once('exit', (code) => {
  process.exit(code ?? 0);
});

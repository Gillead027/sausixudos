import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

function logUpdate(line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  console.log(entry.trim());
  try {
    appendFileSync(join(app.getPath('userData'), 'updater.log'), entry, 'utf8');
  } catch {
    // Se não der pra gravar o log, seguimos sem travar o fluxo de atualização.
  }
}

export function initAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  logUpdate(`Iniciando verificação. Versão atual: ${app.getVersion()}`);
  autoUpdater.on('checking-for-update', () => logUpdate('Verificando atualização…'));
  autoUpdater.on('update-available', (info) => logUpdate(`Atualização encontrada: ${info.version}`));
  autoUpdater.on('update-not-available', (info) => logUpdate(`Nenhuma atualização disponível (última: ${info.version}).`));
  autoUpdater.on('download-progress', (progress) => logUpdate(`Baixando… ${Math.round(progress.percent)}%`));
  autoUpdater.on('update-downloaded', (info) => logUpdate(`Download concluído: ${info.version}`));

  autoUpdater.on('error', (error) => {
    logUpdate(`ERRO: ${error.message}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Atualização disponível',
        message: `Uma nova versão do Sausixudos (${info.version}) está pronta.`,
        detail: 'Deseja reiniciar agora para aplicar a atualização?',
        buttons: ['Atualizar e reiniciar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  void autoUpdater.checkForUpdates();
}

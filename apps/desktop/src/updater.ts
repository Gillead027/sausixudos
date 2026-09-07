import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

export function initAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (error) => {
    console.error('Falha ao verificar atualização:', error);
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

export type MediaAccessKind = 'camera' | 'microphone';

function baseMediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Permissão de mídia negada.';
    if (error.name === 'NotFoundError') return 'Nenhum dispositivo compatível foi encontrado.';
    if (error.name === 'NotReadableError') return 'O dispositivo está sendo usado por outro aplicativo.';
    if (error.name === 'OverconstrainedError') return 'O dispositivo selecionado não aceita essa configuração.';
  }
  return error instanceof Error ? error.message : 'Não foi possível acessar a mídia.';
}

export async function describeMediaError(error: unknown, mediaType?: MediaAccessKind): Promise<string> {
  const errorName = error instanceof Error ? error.name : '';
  const errorMessage = error instanceof Error ? error.message : '';
  const permissionDenied =
    errorName === 'NotAllowedError' ||
    errorName === 'PermissionDeniedError' ||
    /permission denied|notallowederror/i.test(errorMessage);
  if (!permissionDenied || !mediaType) {
    return baseMediaError(error);
  }

  try {
    const status = await window.desktop?.getMediaAccessStatus?.(mediaType);
    if (status === 'denied' || status === 'restricted') {
      const label = mediaType === 'camera' ? 'câmera' : 'microfone';
      return `O Windows bloqueou o acesso à ${label}. Abra Privacidade e permita o acesso para aplicativos da área de trabalho.`;
    }
  } catch {
    // Se o diagnóstico nativo falhar, preserva a mensagem do navegador.
  }

  const label = mediaType === 'camera' ? 'câmera' : 'microfone';
  return `Permissão da ${label} negada. Confira as permissões de privacidade do Windows e tente novamente.`;
}

import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  SOUNDBOARD_AUDIO_DATA_URL_MAX_LENGTH,
  SOUNDBOARD_MAX_DURATION_MS,
  SOUNDBOARD_NAME_MAX_LENGTH,
  type SoundboardSound,
} from '@sausixudos/shared';
import { api } from '../api';
import { CloseIcon, SearchIcon, TrashIcon, UploadIcon } from './Icons';

const ACCEPTED_AUDIO_TYPES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'];

interface DecodedAudio {
  dataUrl: string;
  durationMs: number;
}

// Mede a duração de verdade decodificando o áudio (não confia só no
// tamanho do arquivo) e converte pra data: URL no mesmo padrão já usado
// pra avatar/banner — sem storage de objetos separado (ver DISCORD_PARITY_PLAN.md).
async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  if (!ACCEPTED_AUDIO_TYPES.includes(file.type)) {
    throw new Error('Formato não suportado. Use MP3, OGG, WAV ou WebM.');
  }
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const durationMs = Math.round(audioBuffer.duration * 1000);
    if (durationMs > SOUNDBOARD_MAX_DURATION_MS) {
      throw new Error(`O som deve ter no máximo ${(SOUNDBOARD_MAX_DURATION_MS / 1000).toFixed(1)}s (este tem ${(durationMs / 1000).toFixed(1)}s).`);
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error instanceof Error ? reader.error : new Error('Falha ao ler o arquivo.'));
      reader.readAsDataURL(file);
    });
    if (dataUrl.length > SOUNDBOARD_AUDIO_DATA_URL_MAX_LENGTH) {
      throw new Error('Arquivo de áudio muito grande mesmo após decodificar.');
    }
    return { dataUrl, durationMs };
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function UploadSoundForm({ onCreated }: { onCreated: (sound: SoundboardSound) => void }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🔔');
  const [fileName, setFileName] = useState('');
  const [decoded, setDecoded] = useState<DecodedAudio | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setDecoded(null);
    setFileName(file.name);
    try {
      setDecoded(await decodeAudioFile(file));
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, '').slice(0, SOUNDBOARD_NAME_MAX_LENGTH));
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Não foi possível ler esse arquivo de áudio.');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decoded || !name.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const { sound } = await api.createSoundboardSound(name.trim(), emoji.trim() || '🔔', decoded.dataUrl, decoded.durationMs);
      onCreated(sound);
      setName('');
      setFileName('');
      setDecoded(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível enviar o som.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="soundboard-upload-form" onSubmit={submit}>
      <div className="soundboard-upload-row">
        <input
          className="soundboard-emoji-input"
          value={emoji}
          maxLength={4}
          aria-label="Emoji do som"
          onChange={(event) => setEmoji(event.target.value)}
        />
        <input
          className="soundboard-name-input"
          value={name}
          maxLength={SOUNDBOARD_NAME_MAX_LENGTH}
          placeholder="Nome do som"
          aria-label="Nome do som"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <label className="soundboard-file-picker">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_AUDIO_TYPES.join(',')}
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
        <UploadIcon size={14} />
        <span>{fileName || 'Escolher arquivo (MP3/OGG/WAV/WebM, até 5,5s)'}</span>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={!decoded || !name.trim() || saving}>
        {saving ? 'Enviando…' : 'Adicionar ao soundboard'}
      </button>
    </form>
  );
}

export function SoundboardPanel({
  open,
  onClose,
  sounds,
  ownUserId,
  onPlay,
  onCreated,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  sounds: SoundboardSound[];
  ownUserId: string;
  onPlay: (sound: SoundboardSound) => void;
  onCreated: (sound: SoundboardSound) => void;
  onDeleted: (soundId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  async function deleteSound(soundId: string) {
    if (deletingId) return;
    setDeletingId(soundId);
    try {
      await api.deleteSoundboardSound(soundId);
      onDeleted(soundId);
    } catch {
      // Se a exclusão falhar (ex.: não é o dono), o evento de WebSocket
      // nunca chega e o som simplesmente continua na lista — sem crash.
    } finally {
      setDeletingId(null);
    }
  }

  const filtered = sounds.filter((sound) => sound.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div ref={panelRef} className="soundboard-panel" role="dialog" aria-label="Soundboard">
      <header className="soundboard-panel-header">
        <strong>Soundboard</strong>
        <button type="button" aria-label="Fechar" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="soundboard-search">
        <SearchIcon size={13} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar som"
          aria-label="Buscar som"
        />
      </div>
      <div className="soundboard-grid">
        {filtered.length === 0 ? (
          <p className="soundboard-empty">
            {sounds.length === 0 ? 'Nenhum som ainda — adicione o primeiro.' : 'Nenhum som encontrado.'}
          </p>
        ) : (
          filtered.map((sound) => (
            <div key={sound.id} className="soundboard-item">
              <button type="button" className="soundboard-sound-button" onClick={() => onPlay(sound)} title={`Tocar ${sound.name}`}>
                <span aria-hidden="true">{sound.emoji}</span>
                <span>{sound.name}</span>
              </button>
              {sound.createdBy === ownUserId && (
                <button
                  type="button"
                  className="soundboard-delete-button"
                  aria-label={`Apagar ${sound.name}`}
                  title="Apagar som"
                  disabled={deletingId === sound.id}
                  onClick={() => void deleteSound(sound.id)}
                >
                  <TrashIcon size={12} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
      <div className="soundboard-panel-footer">
        {showUpload ? (
          <UploadSoundForm
            onCreated={(sound) => {
              onCreated(sound);
              setShowUpload(false);
            }}
          />
        ) : (
          <button type="button" className="soundboard-add-button" onClick={() => setShowUpload(true)}>
            <UploadIcon size={13} /> Adicionar som
          </button>
        )}
      </div>
    </div>
  );
}

export function SoundboardToast({
  event,
}: {
  event: { id: number; emoji: string; soundName: string; fromName: string } | null;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!event) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 2_500);
    return () => window.clearTimeout(timer);
  }, [event]);

  if (!event || !visible) return null;
  return (
    <div className="soundboard-toast" role="status">
      <span aria-hidden="true">{event.emoji}</span>
      <span><strong>{event.fromName}</strong> tocou {event.soundName}</span>
    </div>
  );
}

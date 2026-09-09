import { randomUUID } from 'node:crypto';

// U+0300..U+036F = marcas diacríticas combinantes que sobram depois de um
// normalize('NFD') (ex.: "ç" vira "c" + U+0327). Construído via charCode em
// vez de um literal de regex pra não depender de caracteres combinantes
// crus sobrevivendo intactos em toda ferramenta que tocar este arquivo.
const COMBINING_DIACRITICS_PATTERN = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

// Gera um id legível e URL-safe a partir de um nome (usado tanto por canais
// de texto quanto de voz) — normaliza acentos, baixa a caixa, troca tudo que
// não é [a-z0-9] por hífen, e resolve colisão acrescentando um sufixo curto
// aleatório em vez de falhar. maxLength deixa espaço pro sufixo `-xxxxxx`
// (7 chars) sem estourar os limites de 32 caracteres usados nos ids em todo
// o sistema (LiveKit room name, schemas zod, parseVoiceChannels).
export function slugify(name: string, existsById: (id: string) => boolean, maxLength = 24): string {
  const base = name
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS_PATTERN, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength) || 'canal';
  return existsById(base) ? `${base}-${randomUUID().slice(0, 6)}` : base;
}

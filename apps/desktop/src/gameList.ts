// Lista curada de jogos comuns pra detecção de atividade — não temos acesso
// ao banco de milhares de jogos que o Discord mantém, então mapeamos só os
// executáveis mais comuns pra um nome de exibição. Fácil de estender: basta
// adicionar uma entrada { processName, displayName } (processName sem .exe,
// sempre em minúsculas).
export interface KnownGame {
  processName: string;
  displayName: string;
}

export const KNOWN_GAMES: KnownGame[] = [
  { processName: 'valorant', displayName: 'Valorant' },
  { processName: 'valorant-win64-shipping', displayName: 'Valorant' },
  { processName: 'league of legends', displayName: 'League of Legends' },
  { processName: 'leagueclient', displayName: 'League of Legends' },
  { processName: 'cs2', displayName: 'Counter-Strike 2' },
  { processName: 'csgo', displayName: 'Counter-Strike: Global Offensive' },
  { processName: 'fortniteclient-win64-shipping', displayName: 'Fortnite' },
  { processName: 'javaw', displayName: 'Minecraft' },
  { processName: 'minecraft', displayName: 'Minecraft' },
  { processName: 'gta5', displayName: 'GTA V' },
  { processName: 'gta5_enhanced', displayName: 'GTA V' },
  { processName: 'r5apex', displayName: 'Apex Legends' },
  { processName: 'rocketleague', displayName: 'Rocket League' },
  { processName: 'among us', displayName: 'Among Us' },
  { processName: 'overwatch', displayName: 'Overwatch 2' },
  { processName: 'robloxplayerbeta', displayName: 'Roblox' },
  { processName: 'eldenring', displayName: 'Elden Ring' },
  { processName: 'rainbowsix', displayName: 'Rainbow Six Siege' },
  { processName: 'rainbowsix_vulkan', displayName: 'Rainbow Six Siege' },
  { processName: 'dota2', displayName: 'Dota 2' },
  { processName: 'tslgame', displayName: 'PUBG: BATTLEGROUNDS' },
  { processName: 'cod', displayName: 'Call of Duty' },
  { processName: 'ts4_x64', displayName: 'The Sims 4' },
  { processName: 'stardewvalley', displayName: 'Stardew Valley' },
  { processName: 'terraria', displayName: 'Terraria' },
  { processName: 'palworld-win64-shipping', displayName: 'Palworld' },
  { processName: 'fivem', displayName: 'FiveM' },
  { processName: 'fivem_gtaprocess', displayName: 'FiveM' },
];

const KNOWN_GAME_MAP = new Map(KNOWN_GAMES.map((game) => [game.processName, game.displayName]));

export function matchKnownGame(processNames: string[]): string | null {
  for (const rawName of processNames) {
    const normalized = rawName.toLowerCase().replace(/\.exe$/, '');
    const match = KNOWN_GAME_MAP.get(normalized);
    if (match) return match;
  }
  return null;
}

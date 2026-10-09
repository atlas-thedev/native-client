// Curated public Minecraft servers shown on the Servers page.
// Live status (players, ping, icon) is fetched at runtime through
// window.native.server.ping, so this list only holds stable facts.
// `min` is the lowest client version the server accepts.

import cubecraftIcon from '../assets/servers/cubecraft.png';
import hypixelIcon from '../assets/servers/hypixel.png';
import lemoncloudIcon from '../assets/servers/lemoncloud.png';
import mineplexIcon from '../assets/servers/mineplex.png';
import timoliaIcon from '../assets/servers/timolia.png';

export const SERVER_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'featured', label: 'Featured' },
  { id: 'minigames', label: 'Minigames' },
  { id: 'smp', label: 'Survival & SMP' },
  { id: 'skyblock', label: 'Skyblock' },
  { id: 'pvp', label: 'PvP' },
  { id: 'prison', label: 'Prison' },
  { id: 'anarchy', label: 'Anarchy' },
  { id: 'rpg', label: 'RPG' },
  { id: 'towny', label: 'Towny & Earth' },
  { id: 'creative', label: 'Creative' }
];

const s = (name, address, categories, min, region, description, extra = {}) => ({
  name, address, categories, min, region, description, ...extra
});

export const SERVERS = [
  s('Hypixel', 'mc.hypixel.net', ['featured', 'minigames', 'skyblock', 'pvp'], '1.8', 'NA', 'The biggest minigame network: SkyBlock, Bed Wars, SkyWars, Duels and more.', { icon: hypixelIcon }),
  s('DonutSMP', 'donutsmp.net', ['featured', 'smp', 'pvp'], '1.20', 'NA', 'Huge economy SMP with player shops, spawners and crystal PvP.'),
  s('CubeCraft', 'play.cubecraft.net', ['featured', 'minigames', 'skyblock'], '1.20', 'EU', 'Eggwars, SkyWars, Parkour and seasonal minigames.', { icon: cubecraftIcon }),
  s('Wynncraft', 'play.wynncraft.com', ['featured', 'rpg'], '1.12', 'NA', 'A full MMORPG with quests, dungeons, classes and a huge custom map.'),
  s('Minehut', 'minehut.com', ['featured', 'smp', 'creative'], '1.8', 'NA', 'Hub for thousands of free player-run servers.'),
  s('PikaNetwork', 'play.pika-network.net', ['minigames', 'pvp', 'skyblock'], '1.8', 'EU', 'Bed Wars, Practice, Skyblock and Factions.'),
  s('MineBerry', 'play.mineberry.org', ['minigames', 'pvp'], '1.8', 'EU', 'Fast minigames and PvP arenas.'),
  s('ManaCube', 'play.manacube.com', ['skyblock', 'prison', 'smp'], '1.8', 'NA', 'Skyblock, Prison, Parkour and Survival.'),
  s('Jartex Network', 'play.jartexnetwork.com', ['minigames', 'pvp', 'skyblock'], '1.8', 'EU', 'Bed Wars, Practice, Skyblock and Prison.'),
  s('BlocksMC', 'blocksmc.com', ['minigames', 'pvp'], '1.8', 'EU', 'Cracked-friendly minigames: SkyWars, Bed Wars, Egg Wars.'),
  s('LemonCloud', 'play.lemoncloud.net', ['smp', 'skyblock', 'prison'], '1.20', 'NA', 'Survival, Skyblock, Prison and Factions.', { icon: lemoncloudIcon }),
  s('Mineplex', 'us.mineplex.com', ['minigames'], '1.8', 'NA', 'Classic minigame network, back again.', { icon: mineplexIcon }),
  s('GommeHD', 'gommehd.net', ['minigames', 'pvp'], '1.8', 'DE', 'Germany\u2019s biggest network: Bed Wars, SkyWars, Clans.'),
  s('Timolia', 'play.timolia.de', ['minigames', 'pvp'], '1.8', 'DE', 'Minigames and competitive PvP modes.', { icon: timoliaIcon }),
  s('GrieferGames', 'play.griefergames.net', ['smp'], '1.8', 'DE', 'German CityBuild and Survival.'),
  s('Universocraft', 'mc.universocraft.com', ['minigames', 'pvp'], '1.8', 'SA', 'The biggest Spanish-speaking minigame network.'),
  s('Rinaorc', 'play.rinaorc.com', ['minigames', 'pvp'], '1.8', 'EU', 'French minigames network.'),
  s('MineLand', 'mc.mineland.net', ['minigames', 'smp'], '1.8', 'EU', 'Minigames, Survival and Skyblock.'),
  s('MCHub Prison', 'play.mcprison.com', ['prison'], '1.8', 'NA', 'Long-running prison server with gangs and mines.'),
  s('WildPrison', 'play.wildprison.net', ['prison'], '1.8', 'NA', 'OP prison with custom enchants.'),
  s('PurplePrison', 'purpleprison.org', ['prison'], '1.8', 'NA', 'Classic prison with cells and gangs.'),
  s('FadeCloud', 'play.fadecloud.com', ['smp', 'skyblock'], '1.20', 'NA', 'Survival, Skyblock and Lifesteal.'),
  s('Lifesteal Network', 'play.lifesteal.net', ['smp', 'pvp'], '1.20', 'NA', 'Lifesteal SMP: kill players, steal hearts.'),
  s('OPLegends', 'play.oplegends.com', ['prison', 'skyblock'], '1.8', 'NA', 'OP Prison and Skyblock.'),
  s('OPBlocks', 'play.opblocks.com', ['prison', 'skyblock'], '1.8', 'NA', 'OP Prison, Skyblock and Factions.'),
  s('ExtremeCraft', 'play.extremecraft.net', ['smp', 'skyblock', 'prison'], '1.8', 'NA', 'Survival, Skyblock, Prison and Factions.'),
  s('Skyblock.net', 'skyblock.net', ['skyblock'], '1.8', 'NA', 'The original Skyblock server.'),
  s('SaicoPvP', 'play.saicopvp.com', ['pvp', 'prison', 'skyblock'], '1.8', 'NA', 'Factions, Prison and Skyblock.'),
  s('AkumaMC', 'play.akumamc.net', ['pvp', 'skyblock'], '1.8', 'NA', 'Factions and Skyblock.'),
  s('MineSuperior', 'play.minesuperior.com', ['smp', 'skyblock', 'prison'], '1.8', 'NA', 'Survival, Skyblock and Prison.'),
  s('Hoplite', 'hoplite.gg', ['pvp', 'minigames'], '1.21', 'NA', 'Battle royale for modern combat.'),
  s('Gamster', 'play.gamster.org', ['minigames', 'pvp'], '1.8', 'EU', 'Minigames and PvP.'),
  s('Arch', 'mc.arch.lol', ['pvp'], '1.8', 'NA', 'Competitive Practice PvP.'),
  s('Bridger.land', 'play.bridger.land', ['pvp', 'minigames'], '1.8', 'EU', 'Bridging practice and training.'),
  s('ApplesMC', 'play.applemc.fun', ['smp', 'pvp'], '1.20', 'NA', 'Survival and Lifesteal.'),
  s('MysticMC', 'play.mysticmc.co', ['smp', 'skyblock'], '1.20', 'NA', 'Survival and Skyblock.'),
  s('CosmosMC', 'play.cosmosmc.org', ['smp', 'skyblock'], '1.20', 'NA', 'Survival, Skyblock and Oneblock.'),
  s('Performium', 'play.performium.net', ['smp'], '1.20', 'NA', 'Vanilla-friendly survival.'),
  s('Vanilla+', 'play.vanillaplus.net', ['smp'], '1.20', 'NA', 'Vanilla survival with a few quality-of-life touches.'),
  s('CraftYourTown', 'play.craftyourtown.com', ['smp', 'towny'], '1.20', 'NA', 'Towny survival with an economy.'),
  s('EarthMC', 'play.earthmc.net', ['towny'], '1.20', 'NA', 'Towny on a 1:1000 map of the Earth.'),
  s('CivMC', 'play.civmc.net', ['towny', 'smp'], '1.18', 'NA', 'Civilization server: build nations and politics.'),
  s('EcoCityCraft', 'play.ecocitycraft.com', ['towny', 'smp'], '1.8', 'NA', 'City-building economy server.'),
  s('Empire Minecraft', 'play.emc.gs', ['smp'], '1.8', 'NA', 'Friendly survival with residences.'),
  s('Origin Realms', 'play.originrealms.com', ['rpg', 'smp'], '1.20', 'NA', 'Custom-content survival RPG with new mobs and items.'),
  s('Minemora', 'play.minemora.net', ['rpg'], '1.20', 'NA', 'MMORPG adventure.'),
  s('DiamondFire', 'mcdiamondfire.com', ['creative', 'minigames'], '1.20', 'NA', 'Code and play your own games with blocks.'),
  s('2b2t', '2b2t.org', ['anarchy'], '1.12', 'NA', 'The oldest anarchy server: no rules, no resets.'),
  s('9b9t', '9b9t.com', ['anarchy'], '1.12', 'NA', 'Anarchy without the queue.'),
  s('6b6t', '6b6t.org', ['anarchy'], '1.12', 'NA', 'Anarchy with an active community.'),
  s('Constantiam', 'constantiam.net', ['anarchy'], '1.12', 'NA', 'Long-running anarchy server.'),
  s('Minewind', 'minewind.com', ['anarchy', 'pvp'], '1.8', 'NA', 'Semi-anarchy with custom items.')
];

import ChaosCubedArt from '../assets/backgrounds/Chaos_Cubed.jpg';
import TinyTakeoverArt from '../assets/backgrounds/Tiny_Takeover.jpg';
import MountsMayhemArt from '../assets/backgrounds/Mounts_Mayhem.jpg';
import TrickyTrialsArt from '../assets/backgrounds/Tricky_Trials.jpg';
import CopperAgeArt from '../assets/backgrounds/Copper_Age.jpg';
import TrailsTalesArt from '../assets/backgrounds/Trails_Tales.jpg';
import WildUpdateArt from '../assets/backgrounds/Wild_Update.jpg';
import CavesCliffs2Art from '../assets/backgrounds/Caves_Cliffs_2.jpg';
import CavesAndCliffsArt from '../assets/backgrounds/CavesAndCliffs.jpg';
import NetherUpdateArt from '../assets/backgrounds/Nether_Update.jpg';
import BuzzyBeesArt from '../assets/backgrounds/Buzzy_Bees.jpg';
import VillagePillageArt from '../assets/backgrounds/Village_Pillage.jpg';
import UpdateAquaticArt from '../assets/backgrounds/Update_Aquatic.jpg';
import WorldColorArt from '../assets/backgrounds/World_Color.jpg';
import ExplorationUpdateArt from '../assets/backgrounds/Exploration_Update.jpg';
import FrostburnUpdateArt from '../assets/backgrounds/Frostburn_Update.jpg';
import CombatUpdateArt from '../assets/backgrounds/Combat_Update.jpg';
import BountifulUpdateArt from '../assets/backgrounds/Bountiful_Update.jpg';
import ClassicLegacyArt from '../assets/backgrounds/Classic_Legacy.jpg';
import SnapshotArt from '../assets/backgrounds/Snapshot_Art.jpg';

export const ART_ASSETS = {
  Chaos_Cubed: ChaosCubedArt,
  Tiny_Takeover: TinyTakeoverArt,
  Mounts_Mayhem: MountsMayhemArt,
  Copper_Age: CopperAgeArt,
  Tricky_Trials: TrickyTrialsArt,
  Trails_Tales: TrailsTalesArt,
  Wild_Update: WildUpdateArt,
  Caves_Cliffs_2: CavesCliffs2Art,
  CavesAndCliffs: CavesAndCliffsArt,
  Nether_Update: NetherUpdateArt,
  Buzzy_Bees: BuzzyBeesArt,
  Village_Pillage: VillagePillageArt,
  Update_Aquatic: UpdateAquaticArt,
  World_Color: WorldColorArt,
  Exploration_Update: ExplorationUpdateArt,
  Frostburn_Update: FrostburnUpdateArt,
  Combat_Update: CombatUpdateArt,
  Bountiful_Update: BountifulUpdateArt,
  Classic_Legacy: ClassicLegacyArt,
  Snapshot_Art: SnapshotArt,
  default: ChaosCubedArt
};

export const INITIAL_CLUSTERS = [
  {
    id: 'cluster-26-2-fabric',
    name: 'Chaos Cubed',
    version: '26.2',
    mc_version: '26.2',
    loader: 'Fabric',
    mc_loader: 'Fabric',
    artKey: 'Chaos_Cubed',
    art: ChaosCubedArt,
    description: "Minecraft's 26.x updates, starting with the release of \"Tiny Takeover\", primarily focuses on mob charm and quality-of-life improvements, overhauling textures and models for every baby mob that previously lacked a unique model. It also features the golden dandelion, nametag crafting, and other gameplay enhancements.",
    tags: ['PvP', 'SkyBlock', 'Survival'],
    created: Date.now() - 86400000 * 7
  },
  {
    id: 'cluster-26-1-2-fabric',
    name: 'Tiny Takeover',
    version: '26.1.2',
    mc_version: '26.1.2',
    loader: 'Fabric',
    mc_loader: 'Fabric',
    artKey: 'Tiny_Takeover',
    art: TinyTakeoverArt,
    description: "Minecraft's 26.x updates, starting with the release of \"Tiny Takeover\", primarily focuses on mob charm and quality-of-life improvements, overhauling textures and models for baby mobs.",
    tags: ['PvP', 'SkyBlock', 'Survival'],
    created: Date.now() - 86400000 * 14
  },
  {
    id: 'cluster-1-21-11-fabric',
    name: 'Mounts of Mayhem',
    version: '1.21.11',
    mc_version: '1.21.11',
    loader: 'Fabric',
    mc_loader: 'Fabric',
    artKey: 'Mounts_Mayhem',
    art: MountsMayhemArt,
    description: "Rideable mob enhancements, trial chamber adventures, and expanded crafting mechanics for modern Minecraft.",
    tags: ['PvP', 'SkyBlock', 'Survival'],
    created: Date.now() - 86400000 * 21
  },
  {
    id: 'cluster-1-21-1-fabric',
    name: 'Tricky Trials',
    version: '1.21.1',
    mc_version: '1.21.1',
    loader: 'Fabric',
    mc_loader: 'Fabric',
    artKey: 'Tricky_Trials',
    art: TrickyTrialsArt,
    description: "Minecraft's 1.21 update, known as \"Tricky Trials,\" primarily focuses on combat adventures and tinkering, introducing trial chambers, new copper block variants, a new crafting tool, and a new weapon.",
    tags: ['Tricky Trials', 'PvP', 'Survival'],
    created: Date.now() - 86400000 * 30
  }
];

export const RELEASE_LINES = [
  {
    id: '26.2',
    major: '26.2',
    name: 'Chaos Cubed',
    artKey: 'Chaos_Cubed',
    art: ChaosCubedArt,
    description: "Minecraft 26.2 introduces Chaos Cubed with expansive dimension mechanics, mob overhauls, and stunning visual updates.",
    tags: ['Chaos Cubed', 'PvP', 'Survival'],
    versions: [
      { version: '26.2', name: 'Chaos Cubed', artKey: 'Chaos_Cubed', art: ChaosCubedArt, loader: 'Fabric' }
    ]
  },
  {
    id: '26.1',
    major: '26.1',
    name: 'Tiny Takeover',
    artKey: 'Tiny_Takeover',
    art: TinyTakeoverArt,
    description: "Minecraft 26.1 Tiny Takeover revitalizes every baby mob with unique high-detail models, cute animations, and quality-of-life enhancements.",
    tags: ['Tiny Takeover', 'PvP', 'Survival'],
    versions: [
      { version: '26.1.2', name: 'Tiny Takeover 26.1.2', artKey: 'Tiny_Takeover', art: TinyTakeoverArt, loader: 'Fabric' },
      { version: '26.1.1', name: 'Tiny Takeover 26.1.1', artKey: 'Tiny_Takeover', art: TinyTakeoverArt, loader: 'Fabric' },
      { version: '26.1', name: 'Tiny Takeover', artKey: 'Tiny_Takeover', art: TinyTakeoverArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.21',
    major: 21,
    name: 'Tricky Trials',
    artKey: 'Tricky_Trials',
    art: TrickyTrialsArt,
    description: "Trial chambers, the mace, breeze mob, automated crafter, trial spawners, and extensive decorative copper blocks.",
    tags: ['Tricky Trials', 'Combat', 'Tinkering'],
    versions: [
      { version: '1.21.11', name: 'Mounts of Mayhem', artKey: 'Mounts_Mayhem', art: MountsMayhemArt, loader: 'Fabric' },
      { version: '1.21.10', name: 'The Copper Age', artKey: 'Copper_Age', art: CopperAgeArt, loader: 'Fabric' },
      { version: '1.21.9', name: 'Tricky Trials', artKey: 'Tricky_Trials', art: TrickyTrialsArt, loader: 'Fabric' },
      { version: '1.21.8', name: 'Tricky Trials', artKey: 'Tricky_Trials', art: TrickyTrialsArt, loader: 'Fabric' },
      { version: '1.21.7', name: 'Tricky Trials', artKey: 'Tricky_Trials', art: TrickyTrialsArt, loader: 'Fabric' },
      { version: '1.21.4', name: 'Garden Awakens', artKey: 'Tricky_Trials', art: TrickyTrialsArt, loader: 'Fabric' },
      { version: '1.21.1', name: 'Tricky Trials', artKey: 'Tricky_Trials', art: TrickyTrialsArt, loader: 'Fabric' },
      { version: '1.21', name: 'Tricky Trials Launch', artKey: 'Tricky_Trials', art: TrickyTrialsArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.20',
    major: 20,
    name: 'Trails & Tales',
    artKey: 'Trails_Tales',
    art: TrailsTalesArt,
    description: "Archaeology brush sites, the ancient sniffer mob, cherry blossom groves, rideable camels, armor trims, and hanging signs.",
    tags: ['Trails & Tales', 'Archaeology', 'Adventure'],
    versions: [
      { version: '1.20.6', name: 'Trails & Tales Armadillo', artKey: 'Trails_Tales', art: TrailsTalesArt, loader: 'Fabric' },
      { version: '1.20.4', name: 'Trails & Tales', artKey: 'Trails_Tales', art: TrailsTalesArt, loader: 'Fabric' },
      { version: '1.20.1', name: 'Trails & Tales', artKey: 'Trails_Tales', art: TrailsTalesArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.19',
    major: 19,
    name: 'The Wild Update',
    artKey: 'Wild_Update',
    art: WildUpdateArt,
    description: "The Deep Dark, terrifying Warden, ancient cities, mangrove swamp biome, frogs, tadpoles, and chest boats.",
    tags: ['Wild Update', 'Deep Dark', 'Survival'],
    versions: [
      { version: '1.19.4', name: 'The Wild Update', artKey: 'Wild_Update', art: WildUpdateArt, loader: 'Fabric' },
      { version: '1.19.2', name: 'The Wild Update', artKey: 'Wild_Update', art: WildUpdateArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.18',
    major: 18,
    name: 'Caves & Cliffs: Part II',
    artKey: 'Caves_Cliffs_2',
    art: CavesCliffs2Art,
    description: "Massive world height expansion, overhauled terrain generation, soaring mountains, lush caves, and dripstone caves.",
    tags: ['Caves & Cliffs', 'World Gen', 'Exploration'],
    versions: [
      { version: '1.18.2', name: 'Caves & Cliffs Part II', artKey: 'Caves_Cliffs_2', art: CavesCliffs2Art, loader: 'Fabric' }
    ]
  },
  {
    id: '1.17',
    major: 17,
    name: 'Caves & Cliffs: Part I',
    artKey: 'CavesAndCliffs',
    art: CavesAndCliffsArt,
    description: "Axolotls, goats, glow squids, copper ore and lightning rods, amethyst geodes, tinted glass, and deepslate.",
    tags: ['Caves & Cliffs', 'Creatures', 'Blocks'],
    versions: [
      { version: '1.17.1', name: 'Caves & Cliffs Part I', artKey: 'CavesAndCliffs', art: CavesAndCliffsArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.16',
    major: 16,
    name: 'Nether Update',
    artKey: 'Nether_Update',
    art: NetherUpdateArt,
    description: "Complete reimagining of the Nether: netherite gear, piglins, hoglins, striders, crimson & warped forests, and bastions.",
    tags: ['Nether Update', 'Netherite', 'Survival'],
    versions: [
      { version: '1.16.5', name: 'Nether Update', artKey: 'Nether_Update', art: NetherUpdateArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.15',
    major: 15,
    name: 'Buzzy Bees',
    artKey: 'Buzzy_Bees',
    art: BuzzyBeesArt,
    description: "Bees, beehives, honey bottles, honeycombs, and honey blocks with bouncy parkour movement.",
    tags: ['Buzzy Bees', 'Bees', 'Farming'],
    versions: [
      { version: '1.15.2', name: 'Buzzy Bees', artKey: 'Buzzy_Bees', art: BuzzyBeesArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.14',
    major: 14,
    name: 'Village & Pillage',
    artKey: 'Village_Pillage',
    art: VillagePillageArt,
    description: "Redesigned villages, workstations, pillager raids, ravagers, crossbows, foxes, campfires, and sweet berries.",
    tags: ['Village & Pillage', 'Raids', 'Trading'],
    versions: [
      { version: '1.14.4', name: 'Village & Pillage', artKey: 'Village_Pillage', art: VillagePillageArt, loader: 'Fabric' }
    ]
  },
  {
    id: '1.13',
    major: 13,
    name: 'Update Aquatic',
    artKey: 'Update_Aquatic',
    art: UpdateAquaticArt,
    description: "Vibrant ocean depths: coral reefs, dolphins, sea turtles, shipwrecks, drowned, phantoms, tridents, and conduits.",
    tags: ['Update Aquatic', 'Oceans', 'Exploration'],
    versions: [
      { version: '1.13.2', name: 'Update Aquatic', artKey: 'Update_Aquatic', art: UpdateAquaticArt, loader: 'Vanilla' }
    ]
  },
  {
    id: '1.12',
    major: 12,
    name: 'World of Color',
    artKey: 'World_Color',
    art: WorldColorArt,
    description: "Vibrant creative blocks: concrete, glazed terracotta, stained beds, parrots, crafting recipes book, and illusioners.",
    tags: ['World of Color', 'Building', 'Creative'],
    versions: [
      { version: '1.12.2', name: 'World of Color', artKey: 'World_Color', art: WorldColorArt, loader: 'Forge' }
    ]
  },
  {
    id: '1.11',
    major: 11,
    name: 'Exploration Update',
    artKey: 'Exploration_Update',
    art: ExplorationUpdateArt,
    description: "Woodland mansions, vindicators, evokers, totems of undying, shulker boxes, llamas, and cartographer treasure maps.",
    tags: ['Exploration', 'Mansions', 'Adventure'],
    versions: [
      { version: '1.11.2', name: 'Exploration Update', artKey: 'Exploration_Update', art: ExplorationUpdateArt, loader: 'Forge' }
    ]
  },
  {
    id: '1.10',
    major: 10,
    name: 'Frostburn Update',
    artKey: 'Frostburn_Update',
    art: FrostburnUpdateArt,
    description: "Polar bears, husks, strays, magma blocks, Nether wart blocks, red Nether brick, and bone blocks.",
    tags: ['Frostburn', 'Cold & Hot', 'Survival'],
    versions: [
      { version: '1.10.2', name: 'Frostburn Update', artKey: 'Frostburn_Update', art: FrostburnUpdateArt, loader: 'Forge' }
    ]
  },
  {
    id: '1.9',
    major: 9,
    name: 'The Combat Update',
    artKey: 'Combat_Update',
    art: CombatUpdateArt,
    description: "Dual wielding shields, combat cooldown mechanics, tipped arrows, End cities, shulkers, and the elytra glider.",
    tags: ['Combat', 'Elytra', 'The End'],
    versions: [
      { version: '1.9.4', name: 'The Combat Update', artKey: 'Combat_Update', art: CombatUpdateArt, loader: 'Forge' }
    ]
  },
  {
    id: '1.8',
    major: 8,
    name: 'The Bountiful Update',
    artKey: 'Bountiful_Update',
    art: BountifulUpdateArt,
    description: "Ocean monuments, guardians, prismarine, sponges, banners, armor stands, granite/diorite/andesite, and slime blocks.",
    tags: ['Bountiful', 'Monuments', 'PvP'],
    versions: [
      { version: '1.8.9', name: 'The Bountiful Update', artKey: 'Bountiful_Update', art: BountifulUpdateArt, loader: 'Forge' }
    ]
  },
  {
    id: '1.7',
    major: 7,
    name: 'The Update that Changed the World',
    artKey: 'Classic_Legacy',
    art: ClassicLegacyArt,
    description: "Biomes overhaul, stained glass, dark oak and acacia trees, red sand, new flowers, and improved fishing.",
    tags: ['Biomes', 'Legacy', 'PvP'],
    versions: [
      { version: '1.7.10', name: 'The Update that Changed the World', artKey: 'Classic_Legacy', art: ClassicLegacyArt, loader: 'Forge' },
      { version: '1.7.2', name: 'The Update that Changed the World', artKey: 'Classic_Legacy', art: ClassicLegacyArt, loader: 'Forge' }
    ]
  },
  {
    id: 'snapshots',
    major: 'snapshots',
    name: 'Snapshots & Testing',
    artKey: 'Snapshot_Art',
    art: SnapshotArt,
    description: "Bleeding-edge weekly preview snapshots and experimental gameplay builds directly from Mojang Studios.",
    tags: ['Snapshots', 'Experimental', 'Preview'],
    versions: []
  }
];

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  }
  return `${minutes}m`;
}

export function getClusterArt(cluster) {
  if (!cluster) return ART_ASSETS.default;

  const savedArt = String(cluster.art || '');
  const staleBundledArt =
    /^file:/i.test(savedArt) ||
    savedArt.startsWith('/src/assets/') ||
    savedArt.includes('/dist/assets/');

  // Imported Vite assets are runtime URLs. Older builds persisted those URLs in
  // instances.json, leaving development pointed at a packaged /opt/... file and
  // packaged builds pointed at /src/.... Resolve those from the version below.
  // Genuine custom/remote artwork remains supported.
  if (savedArt && !staleBundledArt && !savedArt.includes('540x540') && !savedArt.includes('/v2/images/')) {
    return cluster.art;
  }

  if (cluster.artKey && ART_ASSETS[cluster.artKey]) {
    return ART_ASSETS[cluster.artKey];
  }

  const ver = String(cluster.mc_version || cluster.version || cluster.name || cluster.id || '').trim();
  if (!ver) return ART_ASSETS.default;

  if (ver.startsWith('26.1')) return TinyTakeoverArt;
  // 26.2 and anything newer (26.3, ...) reuses the latest bundled artwork.
  if (ver.startsWith('26')) return ChaosCubedArt;
  if (ver.startsWith('1.21.11') || ver.includes('Mounts')) return MountsMayhemArt;
  if (ver.startsWith('1.21.10') || ver.includes('Copper')) return CopperAgeArt;
  if (ver.startsWith('1.21')) return TrickyTrialsArt;
  if (ver.startsWith('1.20')) return TrailsTalesArt;
  if (ver.startsWith('1.19')) return WildUpdateArt;
  if (ver.startsWith('1.18')) return CavesCliffs2Art;
  if (ver.startsWith('1.17')) return CavesAndCliffsArt;
  if (ver.startsWith('1.16')) return NetherUpdateArt;
  if (ver.startsWith('1.15')) return BuzzyBeesArt;
  if (ver.startsWith('1.14')) return VillagePillageArt;
  if (ver.startsWith('1.13')) return UpdateAquaticArt;
  if (ver.startsWith('1.12')) return WorldColorArt;
  if (ver.startsWith('1.11')) return ExplorationUpdateArt;
  if (ver.startsWith('1.10')) return FrostburnUpdateArt;
  if (ver.startsWith('1.9')) return CombatUpdateArt;
  if (ver.startsWith('1.8')) return BountifulUpdateArt;
  if (ver.includes('snapshot') || /^\d\dw\d\d/.test(ver)) return SnapshotArt;
  if (ver.startsWith('1.') || ver.startsWith('b') || ver.startsWith('a') || ver.startsWith('c')) return ClassicLegacyArt;

  return ART_ASSETS.default;
}

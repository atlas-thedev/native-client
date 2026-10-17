import modrinthIcon from '../../assets/icons/modrinth.svg';
import curseforgeIcon from '../../assets/icons/curseforge.svg';
import vanillaIcon from '../../assets/icons/vanilla.png';
import prismIcon from '../../assets/icons/launchers/prism.svg';
import multimcIcon from '../../assets/icons/launchers/multimc.svg';
import polymcIcon from '../../assets/icons/launchers/polymc.svg';
import atlauncherIcon from '../../assets/icons/launchers/atlauncher.png';
import tlauncherIcon from '../../assets/icons/launchers/tlauncher.png';

/** Other launchers Native can import from, with their own icons (order = how they are listed). */
export const LAUNCHERS = [
  { id: 'modrinth', name: 'Modrinth App', icon: modrinthIcon },
  { id: 'curseforge', name: 'CurseForge', icon: curseforgeIcon },
  { id: 'prism', name: 'Prism Launcher', icon: prismIcon },
  { id: 'tlauncher', name: 'TLauncher', icon: tlauncherIcon },
  { id: 'multimc', name: 'MultiMC', icon: multimcIcon },
  { id: 'polymc', name: 'PolyMC', icon: polymcIcon },
  { id: 'atlauncher', name: 'ATLauncher', icon: atlauncherIcon },
  { id: 'minecraft', name: 'Minecraft Launcher', icon: vanillaIcon }
];

export const launcherById = (id) => LAUNCHERS.find((entry) => entry.id === id) || null;

/** The four everyone knows, for the small icon rows on empty pages. */
export const FEATURED_LAUNCHERS = ['modrinth', 'curseforge', 'prism', 'tlauncher'].map(launcherById);

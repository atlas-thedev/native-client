import cherryBlossomCape from '../../assets/capes/cherry-blossom.png';
import foundersCape from '../../assets/capes/founders.png';
import anniversaryCape from '../../assets/capes/anniversary-15.png';
import purpleHeartCape from '../../assets/capes/purple-heart.png';
import followersCape from '../../assets/capes/followers.png';
import vanillaCape from '../../assets/capes/vanilla.png';
import migratorCape from '../../assets/capes/migrator.png';

// Authentic Mojang cape textures. The PNG sources are downloaded from
// textures.minecraft.net and committed under src/assets/capes.
export const CAPE_PRESETS = [
  { id: 'none', name: 'No Cape', textureUrl: null },
  { id: 'cherry-blossom', name: 'Cherry Blossom', textureUrl: cherryBlossomCape },
  { id: 'founders', name: "Founder's Cape", textureUrl: foundersCape },
  { id: 'anniversary-15', name: '15th Anniversary', textureUrl: anniversaryCape },
  { id: 'purple-heart', name: 'Purple Heart', textureUrl: purpleHeartCape },
  { id: 'followers', name: "Follower's Cape", textureUrl: followersCape },
  { id: 'vanilla', name: 'Vanilla Cape', textureUrl: vanillaCape },
  { id: 'migrator', name: 'Migrator Cape', textureUrl: migratorCape }
];

export { presetTextureDataUrl } from './presetTexture.js';

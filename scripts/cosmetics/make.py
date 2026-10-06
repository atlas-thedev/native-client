"""Generates the bundled Native 3D cosmetics: NCM models + painted textures (server/store/assets) and their
catalog entries. Run: python3 scripts/cosmetics/make.py  (needs Pillow). Thumbnails: scripts/cosmetics/thumbs.mjs"""
import base64, io, json, math, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from ncm import Cube, Part, Mat, solid, build, shade

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ASSETS = os.path.join(ROOT, 'server', 'store', 'assets')


def hexc(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def sprite(art, palette, noise=6):
    """A pixel-art plate material: `art` rows (front view, left = model -x), '.' = transparent."""
    rows = [r for r in art.strip('\n').split('\n')]
    h, w = len(rows), max(len(r) for r in rows)
    rows = [r.ljust(w, '.') for r in rows]

    def at(i, j):
        ch = rows[max(0, min(h - 1, j))][max(0, min(w - 1, i))]
        return None if ch == '.' else palette[ch]

    def fn(face, x, y, fw, fh, rnd):
        if face == 'front':
            return at(x * w // fw, y * h // fh)
        if face == 'back':
            return at(w - 1 - x * w // fw, y * h // fh)
        if face == 'top':
            return at(x * w // fw, 0)
        if face == 'bottom':
            return at(x * w // fw, h - 1)
        if face == 'right':
            return at(0, y * h // fh)
        return at(w - 1, y * h // fh)
    return Mat(fn=fn, noise=noise), (w, h)


def mirror_art(art):
    return '\n'.join(r[::-1] for r in art.strip('\n').split('\n'))


def stripes(colors, width=2, vertical=True, noise=6, edge=0.1, top=None, bottom=None):
    def fn(face, x, y, w, h, rnd):
        if face == 'top' and top is not None:
            return top(x, y, w, h) if callable(top) else top
        if face == 'bottom' and bottom is not None:
            return bottom
        k = (x if vertical else y) // width
        return colors[k % len(colors)]
    return Mat(fn=fn, noise=noise, edge=edge)


def gradient(c1, c2, vertical=True, noise=4):
    def fn(face, x, y, w, h, rnd):
        t = (y / max(1, h - 1)) if vertical else (x / max(1, w - 1))
        return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
    return Mat(fn=fn, noise=noise)


ITEMS = []


def item(id, section, name, description, tags, parts, tex=(64, 64), featured=False, seed=7):
    model, img = build(parts, tex, seed)
    buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
    ITEMS.append({'id': id, 'section': section, 'name': name, 'description': description, 'tags': tags,
                  'featured': featured, 'model': model, 'png': buf.getvalue()})


# ----------------------------------------------------------------------------------------------------- hats
RED, YEL, GRN, BLU = hexc('#e8443a'), hexc('#ffc93c'), hexc('#3fbf5f'), hexc('#3a7be8')


def beanie_top(x, y, w, h):
    # quadrants around the centre, like a classic propeller beanie
    cx, cy = (w - 1) / 2, (h - 1) / 2
    a = math.atan2(y - cy, x - cx)
    return [RED, YEL, GRN, BLU][int(((a + math.pi) / (2 * math.pi)) * 4) % 4]


prop_blade = Mat(fn=lambda f, x, y, w, h, r: (hexc('#ff5a4e') if x < w // 2 else hexc('#4e8dff')) if f in ('top', 'bottom', 'front', 'back') else hexc('#d9d9d9'), noise=5, edge=0.15)
item('propeller-cap', 'hats', 'Propeller Cap', 'A rainbow beanie with a propeller that never stops spinning. Faster when you sprint.',
     ['animated', 'fun'], featured=True, parts=[
         Part('cap', 'head', armor={'slot': 'head'}, cubes=[
             Cube((-4, -8, -4), (8, 3, 8), stripes([RED, YEL, GRN, BLU], 2, top=beanie_top, bottom=hexc('#5a2e2e')), inflate=0.6),
             Cube((-3, -9, -3), (6, 1, 6), Mat(fn=lambda f, x, y, w, h, r: beanie_top(x, y, w, h) if f != 'bottom' else hexc('#5a2e2e'), noise=6), inflate=0.6),
             Cube((-4, -5.6, -8.4), (8, 1, 4), solid(hexc('#2f5fc4'), edge=0.18)),
             Cube((-0.5, -11.6, -0.5), (1, 2, 1), solid(hexc('#ffd84a'))),
         ], children=[
             Part('propeller', pivot=(0, -11.6, 0), anim=[{'type': 'spin', 'axis': 'y', 'speed': 720}], cubes=[
                 Cube((-6, -1, -1), (12, 1, 2), prop_blade),
                 Cube((-1, -2, -1), (2, 1, 2), solid(hexc('#ffd84a'))),
             ]),
         ]),
     ])

GOLD, GOLD_D, GOLD_L = hexc('#f4c430'), hexc('#b8860b'), hexc('#ffe680')
gold = Mat(fn=lambda f, x, y, w, h, r: GOLD_L if y == 0 and f in ('front', 'back', 'left', 'right') else (GOLD_D if y == h - 1 and h > 1 else GOLD), noise=8, edge=0.0)
crown_points = []
for x, z, tall in ((-4.5, -4.5, 1), (-0.5, -4.5, 2), (3.5, -4.5, 1), (-4.5, 3.5, 1), (-0.5, 3.5, 1), (3.5, 3.5, 1), (-4.5, -0.5, 1), (3.5, -0.5, 1)):
    crown_points.append(Cube((x, -10.5 - tall, z), (1, 1 + tall, 1), gold, inflate=0.25))
item('royal-crown', 'hats', 'Royal Crown', 'Solid gold, glowing gems. For the ruler of the lobby.', ['royal', 'glow'], parts=[
    Part('crown', 'head', armor={'slot': 'head'}, cubes=[
        Cube((-4.5, -10.5, -4.5), (9, 2, 1), gold, inflate=0.25),
        Cube((-4.5, -10.5, 3.5), (9, 2, 1), gold, inflate=0.25),
        Cube((-4.5, -10.5, -3.5), (1, 2, 7), gold, inflate=0.25),
        Cube((3.5, -10.5, -3.5), (1, 2, 7), gold, inflate=0.25),
        Cube((-3.5, -9.6, -3.5), (7, 1, 7), solid(hexc('#8e1b2e'), noise=10, edge=0.2)),
    ] + crown_points, children=[
        Part('gems', layer='glow', cubes=[
            Cube((-1, -10, -5), (2, 1, 1), solid(hexc('#ff2b4f'), noise=0, edge=0)),
            Cube((-3.5, -10, -5), (1, 1, 1), solid(hexc('#2bb5ff'), noise=0, edge=0)),
            Cube((2.5, -10, -5), (1, 1, 1), solid(hexc('#2bb5ff'), noise=0, edge=0)),
            Cube((-1, -10, 4), (2, 1, 1), solid(hexc('#36ff7a'), noise=0, edge=0)),
        ]),
        Part('sparkle', layer='glow', pivot=(0, -13.2, -4.6), anim=[{'type': 'blink', 'speed': 0.5, 'amplitude': 0.15}], cubes=[
            Cube((-0.5, -0.5, -0.5), (1, 1, 1), solid(hexc('#fff7c0'), noise=0, edge=0)),
        ]),
    ]),
])

HALO = hexc('#ffd86b')
item('angel-halo', 'hats', 'Angel Halo', 'A warm glowing halo that floats and drifts above your head.', ['animated', 'glow'], parts=[
    Part('halo', 'head', pivot=(0, -12, 0), rotation=(6, 0, 0), layer='glow',
         anim=[{'type': 'bob', 'axis': 'y', 'amplitude': 0.6, 'speed': 0.45}, {'type': 'spin', 'axis': 'y', 'speed': 25}],
         cubes=[
             Cube((-4, 0, -4), (8, 1, 1), solid(HALO, noise=5, edge=0)),
             Cube((-4, 0, 3), (8, 1, 1), solid(HALO, noise=5, edge=0)),
             Cube((-4, 0, -3), (1, 1, 6), solid(HALO, noise=5, edge=0)),
             Cube((3, 0, -3), (1, 1, 6), solid(HALO, noise=5, edge=0)),
         ]),
])

BLACK, BLACK_L = hexc('#1d1d22'), hexc('#34343c')
item('top-hat', 'hats', 'Gentleman Top Hat', 'Tall, black and very proper, with a crimson band.', ['classic'], parts=[
    Part('hat', 'head', armor={'slot': 'head'}, cubes=[
        Cube((-6, -9, -6), (12, 1, 12), solid(BLACK_L, noise=6, edge=0.25)),
        Cube((-4, -16, -4), (8, 7, 8), Mat(fn=lambda f, x, y, w, h, r: BLACK_L if f == 'top' else BLACK, noise=7, edge=0.15), inflate=0.3),
        Cube((-4, -11, -4), (8, 2, 8), Mat(fn=lambda f, x, y, w, h, r: hexc('#b3122e') if y == 0 else hexc('#8a0d22'), noise=6), inflate=0.45),
    ]),
])

# -------------------------------------------------------------------------------------------------- glasses
SHADES = '''
XXXXXXXXX
XWXXX.XWX
.XXX...XX
'''
SHADES = '''
XXXXXXXXX
XWXX.XWXX
.XX...XX.
'''
shades_mat, _ = sprite(SHADES, {'X': BLACK, 'W': hexc('#f2f2f2')}, noise=3)
item('pixel-shades', 'glasses', 'Pixel Shades', 'Deal with it. Pixel-perfect black shades.', ['meme', 'cool'], featured=True, parts=[
    Part('shades', 'head', cubes=[
        Cube((-4.5, -5, -4.9), (9, 3, 1), shades_mat),
        Cube((-4.75, -5, -4.4), (1, 1, 5), solid(BLACK, noise=3)),
        Cube((3.75, -5, -4.4), (1, 1, 5), solid(BLACK, noise=3)),
    ]),
])

NERD_FRAME = '''
.XXX.XXX.
X...X...X
X...X...X
.XXX.XXX.
'''
NERD_LENS = '''
.........
.LLL.LLL.
.LLL.LLL.
.........
'''
frame_mat, _ = sprite(NERD_FRAME, {'X': hexc('#5a3a22')}, noise=8)
lens_mat, _ = sprite(NERD_LENS, {'L': hexc('#bfe6ff', 110)}, noise=0)
item('nerd-glasses', 'glasses', 'Study Glasses', 'Thick tortoiseshell frames with real glass lenses.', ['smart'], parts=[
    Part('frames', 'head', cubes=[
        Cube((-4.5, -5.5, -4.9), (9, 4, 1), frame_mat),
        Cube((-4.75, -5, -4.4), (1, 1, 5), solid(hexc('#5a3a22'), noise=8)),
        Cube((3.75, -5, -4.4), (1, 1, 5), solid(hexc('#5a3a22'), noise=8)),
    ], children=[
        Part('lenses', layer='translucent', cubes=[Cube((-4.5, -5.5, -4.7), (9, 4, 1), lens_mat)]),
    ]),
])

CYAN = hexc('#2ef2ff')
visor_band = Mat(fn=lambda f, x, y, w, h, r: (hexc('#7ffbff') if y == 0 else CYAN) if f in ('front', 'back') else hexc('#0b8c99'), noise=4)
METAL = hexc('#3a3f4b')
item('cyber-visor', 'glasses', 'Cyber Visor', 'A neon HUD visor with a scanner that sweeps side to side.', ['animated', 'glow', 'tech'], featured=True, parts=[
    Part('visor', 'head', cubes=[
        Cube((-4.5, -6.5, -4.9), (9, 1, 1), solid(METAL, edge=0.2)),
        Cube((-4.9, -6.5, -3.9), (1, 3, 3), solid(METAL, edge=0.25)),
        Cube((3.9, -6.5, -3.9), (1, 3, 3), solid(METAL, edge=0.25)),
    ], children=[
        Part('glass', layer='glow', cubes=[Cube((-4.5, -5.5, -4.9), (9, 2, 1), visor_band)]),
        Part('scanner', layer='glow', pivot=(0, -4.5, -5.15), anim=[{'type': 'bob', 'axis': 'x', 'amplitude': 3.4, 'speed': 0.6}],
             cubes=[Cube((-0.5, -1, -0.5), (1, 2, 1), solid(hexc('#ffffff'), noise=0, edge=0))]),
    ]),
])

# ----------------------------------------------------------------------------------------------------- back
ANGEL_IN = '''
....WWWW
..WWWWWW
.WWWWLWW
WWWWLWWW
WWWLWWWW
WWLWWWSW
WLWWWSWW
WWWWSWWW
WWWSWWW.
WWSWWWW.
WSWWWW..
SWWWW...
WWWW....
WW......
'''
ANGEL_OUT = '''
.........WW
.......WWWW
.....WWWWWW
...WWWWWWLW
.WWWWWWLWWW
WWWWWWLWWWW
WWWWWLWWWSW
WWWWLWWWSWW
WWWLWWWSWWW
WWLWWWSWWW.
WLWWWSWWW..
WWWWSWWW...
WWWSWWW....
WWSWWW.....
WSWW.......
SW.........
'''


def wing_pair(prefix, inner, outer, pal, flap_amp, flap_speed, moving, rest_yaw, tip_amp):
    """Right wing extends to -x (the player's right), left wing mirrored; inner plate + outer tip."""
    parts = []
    for side, sgn in (('right', -1), ('left', 1)):
        ia = inner if sgn < 0 else mirror_art(inner)
        oa = outer if sgn < 0 else mirror_art(outer)
        im, (iw, ih) = sprite(ia, pal)
        om, (ow, oh) = sprite(oa, pal)
        ix0 = -iw if sgn < 0 else 0
        ox0 = -ow if sgn < 0 else 0
        tip = Part(f'{side}_tip', pivot=(sgn * (iw - 1), 0, 0),
                   anim=[{'type': 'swing', 'axis': 'y', 'amplitude': tip_amp * sgn * -1, 'speed': flap_speed, 'phase': 0.12, 'moving': moving * sgn * -0.6}],
                   cubes=[Cube((ox0, -oh + 6, 0), (ow, oh, 1), om)])
        parts.append(Part(f'{prefix}_{side}', 'body', pivot=(sgn * 1.5, 2.5, 2.6), rotation=(0, rest_yaw * sgn * -1, 0),
                          armor={'slot': 'chest', 'mode': 'push', 'offset': [0, 0, 1]},
                          anim=[{'type': 'swing', 'axis': 'y', 'amplitude': flap_amp * sgn * -1, 'speed': flap_speed, 'moving': moving * sgn * -1}],
                          cubes=[Cube((ix0, -4, 0), (iw, ih, 1), im)], children=[tip]))
    return parts


item('angel-wings', 'back', 'Angel Wings', 'Soft white feathered wings that gently flap, and beat harder when you run.', ['animated', 'wings'], featured=True,
     parts=wing_pair('wing', ANGEL_IN, ANGEL_OUT, {'W': hexc('#f6f7fb'), 'L': hexc('#dfe6f2'), 'S': hexc('#c3cfe2')}, 9, 0.55, 14, 22, 7))

DRAGON_IN = '''
BBBBBBBB
BMMMMMMB
BMMMMMB.
BMMMMB..
BMMMB...
BMMMMB..
BMMMMMB.
BMMMMB..
BMMMB...
BMMMMB..
BMMB....
BMB.....
BB......
B.......
'''
DRAGON_OUT = '''
BBBBBBBBBBC
MMMMMMMMMB.
MMMMMMMMB..
MMMMMMMB...
MMMMMMMMB..
MMMMMMMMMB.
MMMMMMMMB..
MMMMMMMB...
MMMMMMB....
MMMMMMMB...
MMMMMMB....
MMMMMB.....
MMMMB......
MMMB.......
MMB........
MB.........
'''
item('dragon-wings', 'back', 'Dragon Wings', 'Leathery wings with bony spines and claws. Slow, powerful beats.', ['animated', 'wings', 'dark'],
     parts=wing_pair('dragon', DRAGON_IN, DRAGON_OUT, {'B': hexc('#2a1838'), 'M': hexc('#6b2fa3'), 'C': hexc('#e8e0d0')}, 13, 0.4, 16, 25, 10))

LEATHER, LEATHER_D, LEATHER_L = hexc('#8a5a32'), hexc('#5e3b1f'), hexc('#a8733f')
pack_body = Mat(fn=lambda f, x, y, w, h, r: (LEATHER_D if (f == 'back' and (y in (2, h - 2) or x in (1, w - 2))) else (LEATHER_L if f == 'top' else LEATHER)), noise=9, edge=0.15)
item('explorer-backpack', 'back', 'Explorer Backpack', 'A leather adventuring pack with a bedroll. It bounces as you walk.', ['animated', 'adventure'], parts=[
    Part('pack', 'body', armor={'slot': 'chest', 'mode': 'push', 'offset': [0, 0, 1]},
         anim=[{'type': 'bob', 'axis': 'y', 'amplitude': 0, 'moving': 0.45, 'speed': 1.8}], cubes=[
             Cube((-3.5, 1, 2), (7, 9, 4), pack_body),
             Cube((-2.5, 5, 6), (5, 4, 1), Mat(fn=lambda f, x, y, w, h, r: LEATHER_D if y == 0 else LEATHER, noise=9, edge=0.2)),
             Cube((-4.5, -0.6, 2.6), (9, 2, 3), stripes([hexc('#3f7a3a'), hexc('#336630')], 1, vertical=True, edge=0.15)),
             Cube((-0.5, 4, 6), (1, 2, 1), solid(hexc('#d9b44a'), noise=4)),
         ]),
    Part('straps', 'body', armor={'slot': 'chest'}, cubes=[
        Cube((-3, 0, -2.3), (1, 8, 1), solid(LEATHER_D, noise=8)),
        Cube((2, 0, -2.3), (1, 8, 1), solid(LEATHER_D, noise=8)),
        Cube((-3, -0.4, -2.3), (1, 1, 5), solid(LEATHER_D, noise=8)),
        Cube((2, -0.4, -2.3), (1, 1, 5), solid(LEATHER_D, noise=8)),
    ]),
])

TANK = Mat(fn=lambda f, x, y, w, h, r: hexc('#f2f2f2') if y in (2, 3) else (hexc('#d63a2c') if f != 'top' else hexc('#ff5a48')), noise=6, edge=0.15)
NOZZLE = solid(hexc('#4a4f5a'), edge=0.25)
FLAME = gradient(hexc('#fff3a0'), hexc('#ff3b14'))
CORE = gradient(hexc('#ffffff'), hexc('#ffb02e'))


def flames(side, x):
    return [
        Part(f'flame_{side}', layer='glow', pivot=(x, 12, 5.5),
             anim=[{'type': 'bob', 'axis': 'y', 'amplitude': 0.5, 'speed': 7}, {'type': 'blink', 'speed': 11, 'amplitude': 0.85}],
             cubes=[Cube((-1, 0, -1), (2, 4, 2), FLAME)]),
        Part(f'core_{side}', layer='glow', pivot=(x, 12, 5.5),
             anim=[{'type': 'bob', 'axis': 'y', 'amplitude': 0.8, 'speed': 9, 'phase': 0.3}, {'type': 'blink', 'speed': 13, 'amplitude': 0.7, 'phase': 0.4}],
             cubes=[Cube((-0.5, 0, -0.5), (1, 6, 1), CORE)]),
    ]


item('rocket-jetpack', 'back', 'Rocket Jetpack', 'Twin-tank jetpack with flickering rocket flames. Liftoff not included.', ['animated', 'glow', 'tech'], featured=True, parts=[
    Part('jetpack', 'body', armor={'slot': 'chest', 'mode': 'push', 'offset': [0, 0, 1]}, cubes=[
        Cube((-3, 1, 2), (6, 8, 1), solid(hexc('#3a3f4b'), edge=0.2)),
        Cube((-5, 0, 3), (4, 10, 4), TANK),
        Cube((1, 0, 3), (4, 10, 4), TANK),
        Cube((-4.5, -1, 3.5), (3, 1, 3), solid(hexc('#9aa3b2'))),
        Cube((1.5, -1, 3.5), (3, 1, 3), solid(hexc('#9aa3b2'))),
        Cube((-4.5, 10, 3.5), (3, 2, 3), NOZZLE),
        Cube((1.5, 10, 3.5), (3, 2, 3), NOZZLE),
    ], children=flames('r', -3) + flames('l', 3)),
])

# ---------------------------------------------------------------------------------------------------- shoes
WHITE, WHITE_D = hexc('#f4f4f4'), hexc('#cfcfcf')
SNEAKER_RED = hexc('#e23b3b')


def sneaker_upper(face, x, y, w, h, r):
    if face == 'front' and y < h - 1 and x in (1, 2):
        return WHITE if y % 2 == 0 else hexc('#2a2a2a')   # laces
    if face in ('left', 'right') and y == 1 and 0 < x < w - 1:
        return WHITE                                       # swoosh-ish stripe
    if face == 'top':
        return hexc('#2a2a2a') if 0 < x < w - 1 and y > 0 else SNEAKER_RED
    return SNEAKER_RED


def shoes(prefix, upper, sole, toe, extra=None, height=3):
    parts = []
    for side, leg in (('right', 'rightLeg'), ('left', 'leftLeg')):
        cubes = [
            Cube((-2, 12 - height, -2), (4, height, 4), upper, inflate=0.3),
            Cube((-2, 11, -3), (4, 1, 5), sole, inflate=0.32),
            Cube((-2, 10, -3), (4, 1, 1), toe, inflate=0.3),
        ]
        parts.append(Part(f'{prefix}_{side}', leg, armor={'slot': 'feet'}, cubes=cubes, children=extra(side) if extra else []))
    return parts


item('street-sneakers', 'shoes', 'Street Sneakers', 'Fresh red kicks with white soles and laces.', ['street'],
     parts=shoes('sneaker', Mat(fn=sneaker_upper, noise=5, edge=0.08), solid(WHITE, edge=0.1), solid(SNEAKER_RED, edge=0.1)))

BOOT = Mat(fn=lambda f, x, y, w, h, r: hexc('#ff8a1f') if y == 0 and f != 'top' else hexc('#3a3f4b') if f == 'top' else hexc('#c7ccd6'), noise=7, edge=0.15)


def boot_flames(side):
    return [
        Part(f'thruster_{side}', cubes=[Cube((-1, 9.5, 2.3), (2, 2, 1), NOZZLE)]),
        Part(f'flame_{side}', layer='glow', pivot=(0, 10.5, 3.4),
             anim=[{'type': 'bob', 'axis': 'z', 'amplitude': 0.35, 'speed': 8}, {'type': 'blink', 'speed': 12, 'amplitude': 0.8}],
             cubes=[Cube((-0.5, -0.5, 0), (1, 1, 3), FLAME)]),
    ]


item('rocket-boots', 'shoes', 'Rocket Boots', 'Chrome boots with glowing heel thrusters that sputter as you move.', ['animated', 'glow', 'tech'],
     parts=shoes('boot', BOOT, solid(hexc('#3a3f4b'), edge=0.15), solid(hexc('#ff8a1f'), edge=0.1), extra=boot_flames, height=4))


def main():
    os.makedirs(ASSETS, exist_ok=True)
    catalog = []
    for it in ITEMS:
        with open(os.path.join(ASSETS, f"{it['id']}.model.json"), 'w') as f:
            json.dump(it['model'], f, separators=(',', ':'))
        with open(os.path.join(ASSETS, f"{it['id']}.texture.png.b64"), 'w') as f:
            f.write(base64.b64encode(it['png']).decode() + '\n')
        catalog.append({k: it[k] for k in ('id', 'section', 'name', 'description', 'tags', 'featured')})
        print(f"{it['id']:20} {it['section']:8} parts={sum(1 for _ in walk(it['model']['parts']))} png={len(it['png'])}B")
    with open(os.path.join(os.path.dirname(__file__), 'items.json'), 'w') as f:
        json.dump(catalog, f, indent=2)
    update_store_catalog(catalog)


SECTIONS = [
    {'id': 'hats', 'name': 'Hats', 'blurb': '3D hats that sit on your head in game. Some of them move.'},
    {'id': 'glasses', 'name': 'Glasses', 'blurb': 'Shades, specs and visors for your face.'},
    {'id': 'back', 'name': 'Wings & Backpacks', 'blurb': 'Wings, jetpacks and backpacks that ride on your back.'},
    {'id': 'shoes', 'name': 'Shoes', 'blurb': 'Kicks and boots for your feet.'},
]


def update_store_catalog(items):
    """Writes the cosmetics into server/store/catalog.json (capes stay as they are)."""
    path = os.path.join(ASSETS, '..', 'catalog.json')
    with open(path) as f:
        cat = json.load(f)
    slots = {s['id'] for s in SECTIONS}
    cat['sections'] = [s for s in cat['sections'] if s['id'] not in slots] + SECTIONS
    capes = [i for i in cat['items'] if i.get('section', 'capes') not in slots]
    cos = [{'id': i['id'], 'section': i['section'], 'kind': 'cosmetic', 'name': i['name'], 'description': i['description'],
            'tags': i['tags'], 'author': 'Native', **({'featured': True} if i['featured'] else {})} for i in items]
    cat['items'] = capes + cos
    lines = ['{', '  "version": 1,', '  "sections": [']
    lines += [',\n'.join('    ' + json.dumps(s, ensure_ascii=False) for s in cat['sections'])]
    lines += ['  ],', '  "items": [']
    lines += [',\n'.join('    ' + json.dumps(i, ensure_ascii=False) for i in cat['items'])]
    lines += ['  ]', '}']
    with open(path, 'w') as f:
        f.write('\n'.join(lines) + '\n')


def walk(parts):
    for p in parts:
        yield p
        yield from walk(p.get('children', []))


if __name__ == '__main__':
    main()

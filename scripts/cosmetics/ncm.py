"""Tiny builder for Native cosmetic models (NCM v1): boxes with Minecraft box UV, auto-packed into a texture
and painted per face. Used by make.py to generate the bundled store cosmetics."""
import json, random
from PIL import Image

FACES = ('top', 'bottom', 'right', 'front', 'left', 'back')


def clamp(v):
    return max(0, min(255, int(round(v))))


def shade(rgb, k):
    return tuple(clamp(c * k) for c in rgb[:3]) + ((rgb[3],) if len(rgb) > 3 else (255,))


class Mat:
    """A face painter: paint(face, x, y, w, h, rnd) -> (r, g, b, a)."""
    def __init__(self, fn=None, color=None, noise=7, edge=0.0, faces=None):
        self.fn, self.color, self.noise, self.edge, self.faces = fn, color, noise, edge, faces or {}

    def paint(self, face, x, y, w, h, rnd):
        if face in self.faces:
            m = self.faces[face]
            return m.paint(face, x, y, w, h, rnd) if isinstance(m, Mat) else solid(m).paint(face, x, y, w, h, rnd)
        c = self.fn(face, x, y, w, h, rnd) if self.fn else self.color
        if c is None or (len(c) > 3 and c[3] == 0):
            return (0, 0, 0, 0)
        k = {'top': 1.08, 'bottom': 0.78, 'front': 1.0, 'back': 0.9, 'left': 0.93, 'right': 0.93}[face]
        if self.edge and (x == 0 or y == 0 or x == w - 1 or y == h - 1) and w > 2 and h > 2:
            k *= 1 - self.edge
        n = 1 + (rnd.random() * 2 - 1) * self.noise / 100.0
        return shade(c, k * n)


def solid(color, noise=7, edge=0.12, **kw):
    return Mat(color=color, noise=noise, edge=edge, **kw)


class Cube:
    def __init__(self, origin, size, mat, inflate=0.0, mirror=False):
        self.origin, self.size, self.mat, self.inflate, self.mirror = origin, size, mat, inflate, mirror
        self.uv = None


class Part:
    def __init__(self, id, attach=None, pivot=(0, 0, 0), rotation=(0, 0, 0), cubes=(), children=(), anim=None,
                 layer='cutout', armor=None):
        self.id, self.attach, self.pivot, self.rotation = id, attach, pivot, rotation
        self.cubes, self.children, self.anim, self.layer, self.armor = list(cubes), list(children), anim or [], layer, armor

    def all(self):
        yield self
        for c in self.children:
            yield from c.all()


def build(parts, size=(64, 64), seed=1):
    """Packs every cube's box-UV net into the texture, paints it, returns (model dict, PIL image)."""
    cubes = [c for p in parts for q in p.all() for c in q.cubes]
    W, H = size
    # shelf packing, tallest first
    order = sorted(cubes, key=lambda c: -(c.size[2] + c.size[1]))
    x = y = shelf = 0
    for c in order:
        w, h, d = c.size
        nw, nh = 2 * d + 2 * w, d + h
        if nw > W:
            raise ValueError(f'cube {c.size} too wide for {W}')
        if x + nw > W:
            x, y, shelf = 0, y + shelf, 0
        c.uv = (x, y)
        x += nw
        shelf = max(shelf, nh)
    if y + shelf > H:
        raise ValueError(f'texture {size} too small (needs {y + shelf} rows)')
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    px = img.load()
    rnd = random.Random(seed)
    for c in cubes:
        u, v = c.uv
        w, h, d = c.size
        rects = {
            'top': (u + d, v, w, d), 'bottom': (u + d + w, v, w, d),
            'right': (u, v + d, d, h), 'front': (u + d, v + d, w, h),
            'left': (u + d + w, v + d, d, h), 'back': (u + 2 * d + w, v + d, w, h),
        }
        for face, (fx, fy, fw, fh) in rects.items():
            for j in range(fh):
                for i in range(fw):
                    px[fx + i, fy + j] = c.mat.paint(face, i, j, fw, fh, rnd)

    def part_json(p, root):
        o = {'id': p.id}
        if root:
            o['attach'] = p.attach or 'head'
        if any(p.pivot):
            o['pivot'] = list(p.pivot)
        if any(p.rotation):
            o['rotation'] = list(p.rotation)
        if p.layer != 'cutout':
            o['layer'] = p.layer
        if p.armor:
            o['armor'] = p.armor
        if p.anim:
            o['anim'] = p.anim
        o['cubes'] = [dict({'origin': list(c.origin), 'size': list(c.size), 'uv': list(c.uv)},
                           **({'inflate': c.inflate} if c.inflate else {}), **({'mirror': True} if c.mirror else {})) for c in p.cubes]
        if p.children:
            o['children'] = [part_json(ch, False) for ch in p.children]
        return o

    model = {'format': 1, 'texture': [W, H], 'parts': [part_json(p, True) for p in parts]}
    return model, img

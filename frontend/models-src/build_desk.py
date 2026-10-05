"""Build public/models/desk.glb: the notebook, the pen and the paper airplane as
one rig, with every animation baked into a single timeline.

    blender -b --python models-src/build_desk.py

The raw export (models-src/desk.raw.glb, ~1.6 MB, git-ignored) is then packed
with gltfpack (meshopt, ~0.35 MB) into public/models/desk.glb; that needs npx.

Why one rig: the scene used to load a notebook and a pen separately and steer
the pen at the book every frame, guessing which face it was looking at. Here
the pen is a child of the book and its nib follows the very path the ink is
laid along, so writing is one object rather than two trying to line up.

Timeline (30 fps), split into clips by three.js using the frame ranges stored
in the scene extras ("lumina"):

    idle      pen hovers capped beside the book, the page breathes   (loops)
    to_book   pen uncaps, posts the cap and lands on line one
    write     eight lines of handwriting, then the page turns         (loops)
    to_rest   to_book backwards: back to the hover, cap back on
    fly       the page peels off, folds into a dart and flies away

The ink is revealed in the browser, not here: every ink vertex carries the
time the nib passes it (attribute _reveal, seconds into `write`) and the
material hides what the clip has not reached yet. The pen and the reveal
read the same path, so they cannot drift apart.

Sources: models-src/fountain_pen.glb is "Fountain Pens" by kirikom9000
(CC BY 4.0, sketchfab.com/3d-models/fountain-pens-48de5fd3726d4792a474cb9781549155).
Everything else is generated below.
"""
import json
import math
import os
import random
import shutil
import subprocess
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "desk.raw.glb")
OUT = os.path.join(HERE, "..", "public", "models", "desk.glb")
PEN_SOURCE = os.path.join(HERE, "fountain_pen.glb")

FPS = 30
random.seed(7)
sys.path.insert(0, HERE)
# Everything is sampled every frame anyway; linear keeps the fold stages from
# easing in and out of each other, which reads as a stutter.
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"

# ── Book dimensions (metres-ish; three.js scales the whole rig) ─────────────
BOARD_W, BOARD_H, BOARD_T = 1.035, 1.47, 0.026
PAGE_X0, PAGE_X1 = 0.012, 0.985          # page span from the gutter, per side
PAGE_Y0, PAGE_Y1 = -0.695, 0.695
PAGE_W, PAGE_H = PAGE_X1 - PAGE_X0, PAGE_Y1 - PAGE_Y0
BLOCK_BASE = BOARD_T
BLOCK_T = 0.056                          # page block thickness at its fullest
LIFT = 0.0012                            # the loose page sits this far above the block
INK_LIFT = 0.0007                        # and the ink this far above the loose page

# Ruled lines: shared by the texture and the handwriting, so words sit on them.
RULE_TOP = 0.13                          # first rule, down from the top edge
RULE_GAP = 0.093
RULE_COUNT = 13
WRITE_LINES = 7


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def ease_io(t):
    t = min(max(t, 0.0), 1.0)
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def z_top(a):
    """Height of the page surface at distance `a` from the gutter.

    Pages dip into the spine of an open book; a flat slab reads as a box.
    """
    a = abs(a)
    rise = 1 - (1 - min(a / 0.3, 1.0)) ** 2.2
    return BLOCK_BASE + BLOCK_T * (0.42 + 0.58 * rise) - 0.006 * max(a - 0.3, 0)


def rule_y(k):
    return PAGE_Y1 - RULE_TOP - k * RULE_GAP


def page_uv(x, y):
    """Page texture coordinates for a point on either page (margin on the left)."""
    a = abs(x)
    u = (a - PAGE_X0) / PAGE_W if x >= 0 else 1 - (a - PAGE_X0) / PAGE_W
    return u, (y - PAGE_Y0) / PAGE_H


# ── Scene ───────────────────────────────────────────────────────────────────

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS


def link(obj, parent=None):
    scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


root = link(bpy.data.objects.new("LuminaDesk", None))


# ── Textures ────────────────────────────────────────────────────────────────

def image_from(name, pixels, path):
    height, width = pixels.shape[:2]
    img = bpy.data.images.new(name, width, height, alpha=False)
    img.pixels.foreach_set(pixels.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "JPEG"
    img.save()
    img.pack()
    return img


def paper_pixels(size=1024):
    rng = np.random.default_rng(3)
    v = (np.arange(size) + 0.5) / size
    px = np.empty((size, size, 4), np.float32)
    px[..., 0], px[..., 1], px[..., 2], px[..., 3] = 0.955, 0.94, 0.905, 1.0
    px[..., :3] *= 1 - 0.018 * rng.random((size, size, 1))  # a little tooth
    line_px = 1.6 / size
    for k in range(RULE_COUNT):
        vk = (rule_y(k) - PAGE_Y0) / PAGE_H
        weight = np.clip(1 - np.abs(v - vk) / line_px, 0, 1)[:, None, None]
        px[..., :3] = px[..., :3] * (1 - 0.5 * weight) + np.array([0.55, 0.68, 0.88]) * 0.5 * weight
    u = v
    margin = np.clip(1 - np.abs(u - 0.115) / line_px, 0, 1)[None, :, None]
    px[..., :3] = px[..., :3] * (1 - 0.45 * margin) + np.array([0.9, 0.5, 0.55]) * 0.45 * margin
    return px


def edge_pixels(w=16, h=256):
    rng = np.random.default_rng(5)
    rows = 0.86 + 0.08 * rng.random(h)
    px = np.ones((h, w, 4), np.float32)
    px[..., 0] = rows[:, None] * 0.98
    px[..., 1] = rows[:, None] * 0.96
    px[..., 2] = rows[:, None] * 0.91
    return px


tmp = bpy.app.tempdir
paper_img = image_from("Paper", paper_pixels(), os.path.join(tmp, "paper.jpg"))
edge_img = image_from("PageEdge", edge_pixels(), os.path.join(tmp, "page_edge.jpg"))


def material(name, color, rough=0.6, metal=0.0, image=None, double=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if image is not None:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    mat.use_backface_culling = not double
    return mat


M_COVER = material("Cover", (0.16, 0.09, 0.36), rough=0.85)
M_PAPER = material("Paper", (1, 1, 1), rough=0.92, image=paper_img, double=True)
M_EDGE = material("PageEdge", (1, 1, 1), rough=0.95, image=edge_img)
M_RIBBON = material("Ribbon", (0.95, 0.55, 0.08), rough=0.55)
M_INK = material("Ink", (0.01, 0.018, 0.085), rough=0.6)


def mesh_object(name, bm, mats, parent=root):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me), parent)


# ── Cover ───────────────────────────────────────────────────────────────────

def build_cover():
    bm = bmesh.new()
    for sx in (-1, 1):
        x0, x1 = sorted((sx * 0.02, sx * BOARD_W))
        bmesh.ops.create_cube(bm, size=1, matrix=Matrix.LocRotScale(
            Vector(((x0 + x1) / 2, 0, BOARD_T / 2)), None, Vector((x1 - x0, BOARD_H, BOARD_T))))
    # The spine: a shallow curve under the gutter joining the boards.
    segs, r = 10, 0.05
    verts = []
    for i in range(segs + 1):
        t = math.pi * i / segs
        x = -math.cos(t) * r
        z = -math.sin(t) * 0.022 + 0.004
        verts.append((bm.verts.new((x, BOARD_H / 2, z)), bm.verts.new((x, -BOARD_H / 2, z)),
                      bm.verts.new((x, BOARD_H / 2, z + 0.014)), bm.verts.new((x, -BOARD_H / 2, z + 0.014))))
    for a, b in zip(verts, verts[1:]):
        bm.faces.new((a[0], b[0], b[1], a[1]))   # outside
        bm.faces.new((a[3], b[3], b[2], a[2]))   # inside
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bevel_edges = [e for e in bm.edges if e.is_manifold and abs(e.calc_face_angle(0)) > 1.2]
    bmesh.ops.bevel(bm, geom=bevel_edges, offset=0.006, segments=2, affect="EDGES", profile=0.5)
    return mesh_object("Cover", bm, [M_COVER])


# ── Page blocks ─────────────────────────────────────────────────────────────

def page_columns(n=28):
    """x positions across one page, denser at the gutter where it curves."""
    return [PAGE_X0 + PAGE_W * (i / n) ** 1.6 for i in range(n + 1)]


def build_block(side):
    """One page block: curved top (the page), stacked-paper sides."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    xs = [side * x for x in page_columns()]
    top_f = [bm.verts.new((x, PAGE_Y1, z_top(x))) for x in xs]
    top_b = [bm.verts.new((x, PAGE_Y0, z_top(x))) for x in xs]
    bot_f = [bm.verts.new((x, PAGE_Y1, BLOCK_BASE)) for x in xs]
    bot_b = [bm.verts.new((x, PAGE_Y0, BLOCK_BASE)) for x in xs]

    def face(vs, mat, uvs):
        if side < 0:
            vs, uvs = vs[::-1], uvs[::-1]
        f = bm.faces.new(vs)
        f.material_index = mat
        for loop, coord in zip(f.loops, uvs):
            loop[uv].uv = coord
        return f

    for i in range(len(xs) - 1):
        a, b = xs[i], xs[i + 1]
        face((top_b[i], top_b[i + 1], top_f[i + 1], top_f[i]), 0,
             [page_uv(a, PAGE_Y0), page_uv(b, PAGE_Y0), page_uv(b, PAGE_Y1), page_uv(a, PAGE_Y1)])
        # Head and tail edges of the block: stripes run along the page.
        for verts, v_top, v_bot, flip in ((top_f, top_f, bot_f, True), (top_b, top_b, bot_b, False)):
            quad = (v_bot[i], v_bot[i + 1], v_top[i + 1], v_top[i])
            coords = [(abs(a) * 4, 0), (abs(b) * 4, 0), (abs(b) * 4, 1), (abs(a) * 4, 1)]
            if flip:
                quad, coords = quad[::-1], coords[::-1]
            face(quad, 1, coords)
    face((bot_b[-1], bot_f[-1], top_f[-1], top_b[-1]), 1, [(0, 0), (6, 0), (6, 1), (0, 1)])
    return mesh_object("PagesRight" if side > 0 else "PagesLeft", bm, [M_PAPER, M_EDGE])


def build_ribbon():
    """The bookmark ribbon, lying in the gutter and trailing off the bottom."""
    bm = bmesh.new()
    pts = [(0.004, PAGE_Y1 - 0.05, z_top(0.0) - 0.004)]
    pts += [(0.006 + 0.01 * t, PAGE_Y1 - 0.05 - t * (PAGE_H - 0.02), z_top(0.0) - 0.004) for t in (0.3, 0.6, 1.0)]
    pts += [(0.02, PAGE_Y0 - 0.06, 0.0), (0.03, PAGE_Y0 - 0.16, -0.05)]
    half = 0.012
    rows = [(bm.verts.new((x - half, y, z)), bm.verts.new((x + half, y, z))) for x, y, z in pts]
    for a, b in zip(rows, rows[1:]):
        bm.faces.new((a[0], a[1], b[1], b[0]))
    obj = mesh_object("Ribbon", bm, [M_RIBBON])
    M_RIBBON.use_backface_culling = False
    return obj


# ── The loose page and its rig ──────────────────────────────────────────────

BONES = 10


def bone_joints():
    xs = [PAGE_X0 + PAGE_W * i / BONES for i in range(BONES + 1)]
    return [Vector((x, 0, z_top(x) + LIFT)) for x in xs]


JOINTS = bone_joints()
REST_ANGLES = [math.atan2(b.z - a.z, b.x - a.x) for a, b in zip(JOINTS, JOINTS[1:])]
CENTERS = [(a.x + b.x) / 2 for a, b in zip(JOINTS, JOINTS[1:])]


def bone_weights(x):
    """Tent weights over the bone centres, so the page bends smoothly."""
    if x <= CENTERS[0]:
        return {0: 1.0}
    if x >= CENTERS[-1]:
        return {BONES - 1: 1.0}
    for i in range(BONES - 1):
        if CENTERS[i] <= x <= CENTERS[i + 1]:
            t = (x - CENTERS[i]) / (CENTERS[i + 1] - CENTERS[i])
            return {i: 1 - t, i + 1: t}
    return {BONES - 1: 1.0}


def build_rig():
    arm_data = bpy.data.armatures.new("PageRig")
    arm = link(bpy.data.objects.new("PageRig", arm_data), root)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    previous = None
    for i in range(BONES):
        eb = arm_data.edit_bones.new(f"page_{i}")
        eb.head, eb.tail = JOINTS[i], JOINTS[i + 1]
        eb.roll = 0
        if previous is not None:
            eb.parent, eb.use_connect = previous, True
        previous = eb
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def skin(obj, arm, xs):
    for i in range(BONES):
        obj.vertex_groups.new(name=f"page_{i}")
    for index, x in enumerate(xs):
        for bone, w in bone_weights(x).items():
            obj.vertex_groups[bone].add([index], w, "REPLACE")
    mod = obj.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    obj.parent = arm


def build_loose_page(arm):
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    xs = page_columns(40)
    ny = 8
    grid = [[bm.verts.new((x, PAGE_Y0 + PAGE_H * j / ny, z_top(x) + LIFT)) for j in range(ny + 1)] for x in xs]
    for i in range(len(xs) - 1):
        for j in range(ny):
            f = bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
            for loop in f.loops:
                loop[uv].uv = page_uv(loop.vert.co.x, loop.vert.co.y)
    obj = mesh_object("LoosePage", bm, [M_PAPER])
    skin(obj, arm, [v.co.x for v in obj.data.vertices])
    return obj


# ── Handwriting ─────────────────────────────────────────────────────────────

LETTER_TIME = 0.05      # seconds of pen travel per letter
WORD_GAP_TIME = 0.09
LINE_GAP_TIME = 0.3
X_HEIGHT = 0.025
LETTER_W = 0.024


def word_stroke(x0, base, letters):
    """A cursive-looking stroke: loops of varying height, some ascenders."""
    heights = []
    for _ in range(letters):
        r = random.random()
        heights.append(2.1 if r < 0.18 else (-0.9 if r < 0.26 else 1.0))
    pts = []
    steps = 12
    for k, h in enumerate(heights):
        for s in range(steps):
            t = (k + s / steps)
            phase = 2 * math.pi * (s / steps)
            x = x0 + LETTER_W * t - 0.006 * math.sin(phase)
            if h > 0:
                y = base + X_HEIGHT * h * 0.5 * (1 - math.cos(phase))
            else:
                y = base + X_HEIGHT * 0.5 * (1 - math.cos(phase)) * (1 if s < steps / 2 else -1.8)
            pts.append(Vector((x, y)))
    pts.append(Vector((x0 + LETTER_W * letters, base)))
    return pts


def layout_text():
    """Words for eight lines, as strokes with the time the nib starts each."""
    strokes = []
    clock = 0.18                                   # lowering onto the first word
    x_start, x_end = PAGE_X0 + PAGE_W * 0.15, PAGE_X0 + PAGE_W * 0.93
    for line in range(WRITE_LINES):
        base = rule_y(line) + 0.004
        x = x_start + (0.05 if line in (0, 4) else 0.0)  # an indent for paragraphs
        limit = x_end - (0.32 if line in (3, WRITE_LINES - 1) else 0.0)
        while True:
            letters = random.randint(2, 8)
            if x + letters * LETTER_W > limit:
                break
            pts = word_stroke(x, base, letters)
            duration = letters * LETTER_TIME
            strokes.append({"pts": pts, "t0": clock, "t1": clock + duration, "line": line})
            clock += duration + WORD_GAP_TIME
            x += letters * LETTER_W + 0.026
        clock += LINE_GAP_TIME - WORD_GAP_TIME
    return strokes, clock


STROKES, WRITING_END = layout_text()


def stroke_point(stroke, t):
    """Where the nib is on `stroke` at time t, by arc length."""
    pts = stroke["pts"]
    u = (t - stroke["t0"]) / (stroke["t1"] - stroke["t0"])
    u = min(max(u, 0.0), 1.0) * (len(pts) - 1)
    i = min(int(u), len(pts) - 2)
    return pts[i].lerp(pts[i + 1], u - i)


def store_reveal(mesh, reveal):
    """When the nib passes each vertex, as the U of a second UV map.

    A UV channel rather than a custom attribute because the mesh optimiser
    keeps texture coordinates and drops attributes it does not know.
    """
    layer = mesh.uv_layers.new(name="Reveal")
    for loop in mesh.loops:
        layer.data[loop.index].uv = (reveal[loop.vertex_index], 0.0)


def build_ink(arm):
    bm = bmesh.new()
    reveal = []
    xs = []
    for stroke in STROKES:
        pts = stroke["pts"]
        n = len(pts)
        prev_pair = None
        for i, p in enumerate(pts):
            a, b = pts[max(i - 1, 0)], pts[min(i + 1, n - 1)]
            tangent = (b - a).normalized() if (b - a).length > 1e-9 else Vector((1, 0))
            normal = Vector((-tangent.y, tangent.x))
            width = 0.0021 * (1.0 + 0.5 * max(0.0, -tangent.y))   # downstrokes heavier
            z = z_top(p.x) + LIFT + INK_LIFT
            pair = (bm.verts.new((p.x + normal.x * width, p.y + normal.y * width, z)),
                    bm.verts.new((p.x - normal.x * width, p.y - normal.y * width, z)))
            t = stroke["t0"] + (stroke["t1"] - stroke["t0"]) * i / (n - 1)
            reveal += [t, t]
            xs += [p.x, p.x]
            if prev_pair is not None:
                bm.faces.new((prev_pair[1], pair[1], pair[0], prev_pair[0]))
            prev_pair = pair
    obj = mesh_object("Ink", bm, [M_INK])
    store_reveal(obj.data, reveal)
    skin(obj, arm, xs)
    return obj


# ── The pen ─────────────────────────────────────────────────────────────────

PEN_LENGTH = 0.92        # body + nib, cap off


def build_pen():
    """Import the fountain pen and re-seat it: origin at the nib, barrel on +Z."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=PEN_SOURCE)
    imported = [o for o in bpy.data.objects if o not in before]
    parts = {}
    for o in imported:
        if o.type == "MESH":
            parts[o.name.split("_low")[0]] = o
    # Only the first pen of the pair; the second and the ground plane go.
    keep = {k: parts[k] for k in ("body", "nib", "cap", "clip")}
    tip_x, rear_x, axis_z = 7.785, -10.888, 0.92
    scale = PEN_LENGTH / (tip_x - rear_x)
    # Old x runs nib to rear along -x; new +Z runs nib to rear. Clip side (+y) -> +X.
    remap = Matrix(((0, scale, 0, 0), (0, 0, scale, -axis_z * scale), (-scale, 0, 0, tip_x * scale), (0, 0, 0, 1)))
    for o in keep.values():
        o.data.transform(remap @ o.matrix_world)
        o.matrix_world = Matrix()
        o.parent = None
    for o in imported:
        if o not in keep.values():
            bpy.data.objects.remove(o, do_unlink=True)

    def join(name, objs):
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        objs[0].name = objs[0].data.name = name
        return objs[0]

    body = join("Pen", [keep["body"], keep["nib"]])
    cap = join("PenCap", [keep["cap"], keep["clip"]])
    body.parent = root
    cap.parent = body
    for img in bpy.data.images:
        if img.size[0] > 512 and img not in (paper_img, edge_img):
            img.scale(512, 512)
    recolor_lacquer(bpy.data.images["Image_0"])
    return body, cap


# Violet lacquer, not black: the app is nearly black (#030303), and a black pen
# vanished against it whenever it was not over the page. Violet reads on both
# the dark background and the white paper, and the gold trim is left alone.
LACQUER = np.array([0.105, 0.036, 0.55])   # #5b35c4, linear


def recolor_lacquer(image):
    w, h = image.size
    px = np.array(image.pixels[:], dtype=np.float32).reshape(h, w, 4)
    rgb = px[..., :3]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    black = np.clip((0.14 - lum) / 0.14, 0, 1) * np.clip((0.1 - sat) / 0.1, 0, 1)
    tinted = LACQUER[None, None, :] * (0.65 + 4.0 * lum[..., None])
    px[..., :3] = rgb * (1 - black[..., None]) + tinted * black[..., None]
    image.pixels.foreach_set(px.ravel())
    image.update()


# Cap travel, in the pen's own frame: pulled off past the nib, swung round,
# slid onto the rear end ("posted"). See the docstring above for why it has
# to be turned end over end: the open end has to face the pen both times.
CAP_OPEN_Z = 7.635 / 18.673 * PEN_LENGTH
POSTED_Z = (18.673 - 2.3 + 7.635) / 18.673 * PEN_LENGTH


def cap_pose(u):
    """u = 0 capped, 1 posted."""
    flip = Quaternion((1, 0, 0), math.pi)
    if u <= 0.3:
        k = ease(u / 0.3)
        return Vector((0, 0, -0.22 * k)), Quaternion()
    if u <= 0.75:
        k = ease_io((u - 0.3) / 0.45)
        rot = Quaternion().slerp(flip, k)
        loc = Vector((0.13 * math.sin(math.pi * k), 0, -0.22 + (POSTED_Z + 0.18 + 0.22) * k))
        return loc, rot
    k = ease((u - 0.75) / 0.25)
    return Vector((0, 0, POSTED_Z + 0.18 * (1 - k))), flip


def pen_rotation(direction, roll=0.0):
    q = Vector(direction).normalized().to_track_quat("Z", "X")
    return q @ Quaternion((0, 0, 1), roll)


# The hover is over the right page, so the paper is always behind the pen.
IDLE_NIB = Vector((0.62, -0.22, 0.3))
IDLE_DIR = Vector((0.12, 0.3, 0.95))
WRITE_DIR = Vector((0.3, -0.8, 0.52))


def idle_pose(t):
    bob = math.sin(2 * math.pi * t / 4.0)
    sway = math.sin(2 * math.pi * t / 4.0 + 1.1)
    loc = IDLE_NIB + Vector((0.0, 0.0, 0.028 * bob))
    direction = IDLE_DIR + Vector((0.04 * sway, 0.02 * bob, 0))
    return loc, pen_rotation(direction, 0.05 * sway)


def write_start():
    first = STROKES[0]["pts"][0]
    return Vector((first.x, first.y, z_top(first.x) + LIFT + 0.03))


def smoothed_nib(t, window=0.05):
    """The nib, low-passed: a hand does not trace every loop at 30 fps."""
    samples = [nib_target(t + window * (k / 4 - 0.5)) for k in range(5)]
    return sum(samples, Vector()) / len(samples)


def nib_target(t):
    """The raw nib position during writing (before the page turn)."""
    t = min(max(t, 0.0), WRITING_END)
    for i, stroke in enumerate(STROKES):
        if t < stroke["t0"]:
            # Between strokes: lifted, gliding to the next word or line.
            prev = STROKES[i - 1] if i else None
            a = prev["pts"][-1] if prev else STROKES[0]["pts"][0]
            a_t = prev["t1"] if prev else 0.0
            b = stroke["pts"][0]
            k = (t - a_t) / max(stroke["t0"] - a_t, 1e-6)
            new_line = prev is None or prev["line"] != stroke["line"]
            hop = 0.03 if new_line else 0.009
            if prev is None:
                hop = 0.03 * (1 - ease(k))   # coming down onto the page
                xy = b
            else:
                xy = a.lerp(b, ease_io(k))
                hop = hop * math.sin(math.pi * k)
            return Vector((xy.x, xy.y, z_top(xy.x) + LIFT + INK_LIFT + hop))
        if t <= stroke["t1"]:
            p = stroke_point(stroke, t)
            return Vector((p.x, p.y, z_top(p.x) + LIFT + INK_LIFT))
    last = STROKES[-1]["pts"][-1]
    return Vector((last.x, last.y, z_top(last.x) + LIFT + INK_LIFT))


# Write clip after the last word: lift aside, turn the page, come back.
TURN_AWAY = 0.45
TURN_TIME = 1.25
TURN_BACK = 0.55
WRITE_DURATION = WRITING_END + TURN_AWAY + TURN_TIME + TURN_BACK
TURN_START = WRITING_END + TURN_AWAY
ASIDE = Vector((0.36, -0.95, 0.55))   # clear of the page as it turns


def write_pose(t):
    """Pen location and rotation at time t of the write clip."""
    if t <= WRITING_END:
        nib = smoothed_nib(t)
        ahead = nib_target(t + 0.06) - nib_target(t - 0.06)
        lean = Vector((0.6 * ahead.x, 0.6 * ahead.y, 0)) * 4
        wobble = 0.03 * math.sin(t * 9.0)
        return nib, pen_rotation(WRITE_DIR + lean + Vector((wobble, 0, 0)), 0.04 * math.sin(t * 2.3))
    end_nib = nib_target(WRITING_END)
    if t <= TURN_START + TURN_TIME:
        k = ease_io(min((t - WRITING_END) / TURN_AWAY, 1.0))
        loc = end_nib.lerp(ASIDE, k) + Vector((0, 0, 0.12 * math.sin(math.pi * k)))
        direction = WRITE_DIR.lerp(IDLE_DIR, 0.6 * k)
        hover = 0.012 * math.sin(2 * math.pi * max(t - TURN_START, 0) / TURN_TIME)
        return loc + Vector((0, 0, hover)), pen_rotation(direction)
    k = ease_io((t - TURN_START - TURN_TIME) / TURN_BACK)
    loc = ASIDE.lerp(write_start(), k) + Vector((0, 0, 0.1 * math.sin(math.pi * k)))
    direction = WRITE_DIR.lerp(IDLE_DIR, 0.6 * (1 - k))
    return loc, pen_rotation(direction)


TO_BOOK = 1.5


def to_book_pose(t):
    """Hover -> line one, uncapping on the way. Returns pen loc, rot, cap u."""
    k = ease_io(t / TO_BOOK)
    start_loc, start_rot = idle_pose(0)
    end_loc, end_rot = write_pose(0)
    # Over the top in an arc, as a hand would bring a pen in.
    mid = start_loc.lerp(end_loc, 0.5) + Vector((0.12, -0.1, 0.32))
    loc = (1 - k) ** 2 * start_loc + 2 * (1 - k) * k * mid + k ** 2 * end_loc
    rot = start_rot.slerp(end_rot, ease_io(min(t / (TO_BOOK * 0.85), 1)))
    cap_u = ease(min(t / (TO_BOOK * 0.8), 1))
    return loc, rot, cap_u


# ── Page animation ──────────────────────────────────────────────────────────

def page_angles(turn, breathe=0.0):
    """World angle of each bone. turn 0..1 carries the page over the spine;
    the outer bones lead, which lifts it by the corner and curls it."""
    out = []
    lag = 0.05
    span = 1 - lag * (BONES - 1)
    for i in range(BONES):
        delay = lag * (BONES - 1 - i)
        u = ease_io(min(max((turn - delay) / span, 0.0), 1.0))
        rest, landed = REST_ANGLES[i], math.pi - REST_ANGLES[i]
        a = rest + (landed - rest) * u
        a += breathe * (i / BONES) ** 2
        out.append(a)
    return out


def pose_page(arm, angles):
    """Set the bones from their world angles.

    Every bone turns about the same world axis (the spine runs along Y), so
    rotations commute and each bone's local rotation is just its angle less
    its parent's, about world Y expressed in the bone's own frame.
    """
    previous = 0.0
    for i in range(BONES):
        pb = arm.pose.bones[f"page_{i}"]
        axis = arm.data.bones[pb.name].matrix_local.to_3x3().inverted() @ Vector((0, 1, 0))
        # Rotating about +Y carries +X down, and a positive angle lifts the page.
        delta = -(angles[i] - REST_ANGLES[i])
        pb.rotation_quaternion = Quaternion(axis, delta - previous)
        previous = delta


# ── Timeline ────────────────────────────────────────────────────────────────

def frames(seconds):
    return int(round(seconds * FPS))


RANGES = {}
cursor = 0


def reserve(name, seconds, gap=10):
    global cursor
    start = cursor
    end = start + frames(seconds)
    RANGES[name] = [start, end]
    cursor = end + gap
    return start, end


reserve("idle", 4.0)
reserve("to_book", TO_BOOK)
reserve("write", WRITE_DURATION)
reserve("to_rest", TO_BOOK)
FLY_TIME = 4.2
reserve("fly", FLY_TIME)
scene.frame_start, scene.frame_end = 0, cursor


def key_transform(obj, frame, loc, rot):
    obj.rotation_mode = "QUATERNION"
    obj.location = loc
    obj.rotation_quaternion = rot
    obj.keyframe_insert("location", frame=frame)
    obj.keyframe_insert("rotation_quaternion", frame=frame)


def key_pose(arm, frame):
    for pb in arm.pose.bones:
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        pb.keyframe_insert("location", frame=frame)


def animate(pen, cap, arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    capped = (Vector(), Quaternion())
    posted = cap_pose(1.0)

    def at(name):
        start, end = RANGES[name]
        return range(start, end + 1), start

    span, start = at("idle")
    for f in span:
        t = (f - start) / FPS
        key_transform(pen, f, *idle_pose(t))
        key_transform(cap, f, *capped)
        pose_page(arm, page_angles(0.0, 0.035 * (0.5 - 0.5 * math.cos(2 * math.pi * t / 4.0))))
        key_pose(arm, f)

    for name, reverse in (("to_book", False), ("to_rest", True)):
        span, start = at(name)
        for f in span:
            t = (f - start) / FPS
            loc, rot, cap_u = to_book_pose(TO_BOOK - t if reverse else t)
            key_transform(pen, f, loc, rot)
            key_transform(cap, f, *cap_pose(cap_u))
            pose_page(arm, page_angles(0.0))
            key_pose(arm, f)

    span, start = at("write")
    for f in span:
        t = min((f - start) / FPS, WRITE_DURATION)
        key_transform(pen, f, *write_pose(t))
        key_transform(cap, f, *posted)
        turn = (t - TURN_START) / TURN_TIME
        # The page stays turned to the very last frame. The loop then wraps to a
        # flat page on the right with the ink hidden again (the reveal restarts),
        # while the left shows a blank page either way: no visible jump.
        pose_page(arm, page_angles(min(max(turn, 0.0), 1.0)))
        key_pose(arm, f)

    span, start = at("fly")
    for f in span:
        key_transform(pen, f, *idle_pose(0))
        key_transform(cap, f, *capped)
        pose_page(arm, page_angles(0.0))
        key_pose(arm, f)


# ── Build ───────────────────────────────────────────────────────────────────

cover = build_cover()
build_block(1)
build_block(-1)
build_ribbon()
rig = build_rig()
build_loose_page(rig)
build_ink(rig)
pen, cap = build_pen()
animate(pen, cap, rig)

import airplane  # noqa: E402  (kept apart: it is its own small origami solver)

airplane.build(root, M_PAPER, M_INK, RANGES["fly"], FPS, STROKES, z_top, LIFT, INK_LIFT, PAGE_X0, PAGE_W,
               PAGE_Y0, PAGE_H, page_uv)

scene["lumina"] = json.dumps({
    "fps": FPS,
    "ranges": RANGES,
    "write": {"writing_end": WRITING_END, "turn_start": TURN_START, "turn_end": TURN_START + TURN_TIME,
              "duration": WRITE_DURATION},
})
root["lumina"] = scene["lumina"]

bpy.ops.export_scene.gltf(
    filepath=RAW,
    export_format="GLB",
    export_animation_mode="SCENE",
    export_anim_scene_split_object=False,
    export_force_sampling=True,
    export_optimize_animation_size=False,
    export_extras=True,
    export_image_format="JPEG",
    export_jpeg_quality=82,
    export_morph_normal=False,
)
# -kn/-ke keep the node names and extras the app reads, -kv the ink's reveal
# channel, -vtf keeps that channel in floats (it holds seconds, not UVs).
npx = shutil.which("npx")
if npx:
    subprocess.run([npx, "-y", "gltfpack", "-i", RAW, "-o", OUT, "-cc", "-kn", "-km", "-ke", "-kv", "-vtf"],
                   check=True)
else:
    print("npx not found: copying the unpacked model instead")
    shutil.copyfile(RAW, OUT)

if os.environ.get("DESK_BLEND"):
    bpy.ops.wm.save_as_mainfile(filepath=os.environ["DESK_BLEND"])
print("RANGES", json.dumps(RANGES), "write", WRITE_DURATION)

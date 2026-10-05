"""The paper airplane: the written page peels off the book, folds into a dart
and flies away. Used by build_desk.py.

Folding is done the way paper does it: each fold rotates everything on one side
of a crease line, rigidly, about that line. The sheet is first cut along every
crease (and along the image of every crease on the layers folded over it), so
no face ever straddles a fold. Each fold is stored as a few morph targets at
intermediate angles; played in sequence they trace the arc instead of letting
the flap shrink through the crease, which is what a single target would do.

Morph targets add up, so target i holds the step from state i-1 to state i:
with every earlier weight at 1 and this one ramping, the mesh is exactly at
state i-1 moving to state i.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

EPS1, EPS2 = 0.0015, 0.0042      # layer spacing, so stacked paper does not z-fight


def _reflect(p, a, d):
    """Mirror 2D point p across the line through a with unit direction d."""
    v = p - a
    along = d * v.dot(d)
    return a + along * 2 - v


def _reflect_line(line, mirror):
    a, d = line
    ma, md = mirror
    p, q = _reflect(a, ma, md), _reflect(a + d, ma, md)
    return p, (q - p).normalized()


def _side(p, line):
    a, d = line
    v = p - a
    return d.x * v.y - d.y * v.x


def _rotate(p, origin, axis, angle):
    return origin + Matrix.Rotation(angle, 3, axis) @ (p - origin)


class Fold:
    def __init__(self, hw, hh):
        self.hw, self.hh = hw, hh
        nose = Vector((0.0, hh))
        self.nose = nose
        s, c = math.sin(math.radians(22.5)), math.cos(math.radians(22.5))
        self.depth = 0.075 * hw * 2       # keel depth at the tail
        self.lines = {}
        for side in (-1, 1):
            l1 = (nose, Vector((side * hw, -hw)).normalized())          # corner to the centre
            l2 = (nose, Vector((side * s, -c)).normalized())            # edge to the centre
            tail = Vector((side * self.depth, -hh))
            w = (nose, (tail - nose).normalized())                      # wing crease
            self.lines[side] = {"l1": l1, "l2": l2, "w": w}

    def cut_lines(self):
        """Every line the sheet has to be cut along."""
        out = [(self.nose, Vector((0, -1)))]
        for side in (-1, 1):
            l1, l2, w = (self.lines[side][k] for k in ("l1", "l2", "w"))
            out += [l1, l2, _reflect_line(l2, l1), w, _reflect_line(w, l2), _reflect_line(w, l1),
                    _reflect_line(_reflect_line(w, l2), l1)]
        return out

    def states(self, points, offsets, curved):
        """Positions of `points` (2D sheet coords) after each stage.

        offsets: height of each point above the paper (ink sits a hair above).
        curved:  z of each point while still lying on the curved page.
        Returns [curved, flat, step1 x3, step2 x3, step3 x2, step4 x2].
        """
        hw, hh = self.hw, self.hh
        P = [Vector((p.x, p.y, o)) for p, o in zip(points, offsets)]
        states = [[Vector((p.x, p.y, z)) for p, z in zip(points, curved)], [q.copy() for q in P]]

        def fold_step(cur, select, axis_of, angle_of, lift, fractions):
            moving = [select(i, q) for i, q in enumerate(cur)]
            out = []
            for f in fractions:
                nxt = []
                for i, q in enumerate(cur):
                    side = moving[i]
                    if not side:
                        nxt.append(q.copy())
                        continue
                    origin, axis = axis_of(side)
                    r = _rotate(q, origin, axis, angle_of(side) * f)
                    nxt.append(r + lift(side, q) * f)
                out.append(nxt)
            return out

        def corner_up(line, corner):
            """Rotation sign that brings the far side of `line` up out of the sheet."""
            a, d = line
            axis = Vector((d.x, d.y, 0))
            probe = _rotate(Vector((corner.x, corner.y, 0)), Vector((a.x, a.y, 0)), axis, math.pi / 2)
            return 1 if probe.z > 0 else -1

        # Step 1: corners to the centre line.
        def sel1(i, q):
            for side in (-1, 1):
                l1 = self.lines[side]["l1"]
                corner = Vector((side * hw, hh))
                if math.copysign(1, _side(corner, l1)) * _side(q.to_2d(), l1) > 1e-7:
                    return side
            return 0

        def axis_l(key):
            def f(side):
                a, d = self.lines[side][key]
                return Vector((a.x, a.y, 0)), Vector((d.x, d.y, 0))
            return f

        signs1 = {s: corner_up(self.lines[s]["l1"], Vector((s * hw, hh))) for s in (-1, 1)}
        cur = P
        steps = fold_step(cur, sel1, axis_l("l1"), lambda s: signs1[s] * math.pi,
                          lambda s, q: Vector((0, 0, EPS1)), (1 / 3, 2 / 3, 1))
        states += steps
        cur = steps[-1]

        # Step 2: the new slanted edges to the centre line.
        def sel2(i, q):
            for side in (-1, 1):
                l2 = self.lines[side]["l2"]
                outer = Vector((side * hw, 0))
                if math.copysign(1, _side(outer, l2)) * _side(q.to_2d(), l2) > 1e-7:
                    return side
            return 0

        signs2 = {s: corner_up(self.lines[s]["l2"], Vector((s * hw, 0))) for s in (-1, 1)}
        steps = fold_step(cur, sel2, axis_l("l2"), lambda s: signs2[s] * math.pi,
                          lambda s, q: Vector((0, 0, EPS2)), (1 / 3, 2 / 3, 1))
        states += steps
        cur = steps[-1]
        flat2 = cur

        # Step 3: in half, both halves rising off the keel.
        def sel3(i, q):
            x = flat2[i].x
            return -1 if x < -1e-7 else (1 if x > 1e-7 else 0)

        centre = (Vector((0, hh, 0)), Vector((0, 1, 0)))
        steps = fold_step(cur, sel3, lambda s: centre, lambda s: s * -math.pi / 2,
                          lambda s, q: Vector(), (1 / 2, 1))
        states += steps
        cur = steps[-1]

        # Step 4: wings out, along the crease as it now stands in each wall.
        def wing_x(y):
            return self.depth * (hh - y) / (2 * hh)

        def sel4(i, q):
            p = flat2[i]
            if p.x < -wing_x(p.y) - 1e-7:
                return -1
            if p.x > wing_x(p.y) + 1e-7:
                return 1
            return 0

        def wing_axis(side):
            a, d = self.lines[side]["w"]
            p0 = _rotate(Vector((a.x, a.y, 0)), *centre, side * -math.pi / 2)
            p1 = _rotate(Vector((a.x + d.x, a.y + d.y, 0)), *centre, side * -math.pi / 2)
            return p0, (p1 - p0).normalized()

        def wing_sign(side):
            origin, axis = wing_axis(side)
            probe = _rotate(origin + Vector((0, 0, 0.1)), origin, axis, math.pi / 2)
            return 1 if probe.x * side > 0 else -1

        signs4 = {s: wing_sign(s) for s in (-1, 1)}
        steps = fold_step(cur, sel4, wing_axis, lambda s: signs4[s] * math.radians(84),
                          lambda s, q: Vector(), (1 / 2, 1))
        states += steps
        return states


# Seconds into the fly clip at which each stage runs (start, end).
STAGES = [(0.05, 0.4)] + [(0.4 + 0.13 * i, 0.53 + 0.13 * i) for i in range(3)] \
    + [(0.85 + 0.13 * i, 0.98 + 0.13 * i) for i in range(3)] \
    + [(1.3 + 0.16 * i, 1.46 + 0.16 * i) for i in range(2)] \
    + [(1.65 + 0.15 * i, 1.8 + 0.15 * i) for i in range(2)]
LAUNCH = 2.25


def _add_keys(obj, states, frame0, frame1, fps):
    obj.shape_key_add(name="Basis", from_mix=False)
    base = states[0]
    for i in range(1, len(states)):
        key = obj.shape_key_add(name=f"fold_{i}", from_mix=False)
        for v, (a, b) in enumerate(zip(states[i - 1], states[i])):
            key.data[v].co = base[v] + (b - a)
        start, end = STAGES[i - 1]
        for frame, value in ((frame0, 0.0), (frame0 + start * fps, 0.0), (frame0 + end * fps, 1.0), (frame1, 1.0)):
            key.value = value
            key.keyframe_insert("value", frame=round(frame))


def _bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return p0 * u ** 3 + p1 * 3 * u * u * t + p2 * 3 * u * t * t + p3 * t ** 3


def build(root, m_paper, m_ink, fly_range, fps, strokes, z_top, lift, ink_lift, page_x0, page_w,
          page_y0, page_h, page_uv):
    hw, hh = page_w / 2, page_h / 2
    cx = page_x0 + hw
    base_z = z_top(cx) + lift + 0.0004
    fold = Fold(hw, hh)

    # The sheet, cut along every crease.
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=14, y_segments=20, size=1.0)
    for v in bm.verts:
        v.co.x *= hw
        v.co.y *= hh
    for a, d in fold.cut_lines():
        normal = Vector((-d.y, d.x, 0))
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector((a.x, a.y, 0)), plane_no=normal)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = page_uv(cx + loop.vert.co.x, loop.vert.co.y)
    me = bpy.data.meshes.new("Airplane")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(m_paper)

    plane_root = bpy.data.objects.new("AirplaneRoot", None)
    bpy.context.scene.collection.objects.link(plane_root)
    plane_root.parent = root
    sheet = bpy.data.objects.new("Airplane", me)
    bpy.context.scene.collection.objects.link(sheet)
    sheet.parent = plane_root

    pts = [v.co.to_2d() for v in me.vertices]
    curved = [z_top(cx + p.x) + lift + 0.0004 - base_z for p in pts]
    sheet_states = fold.states(pts, [0.0] * len(pts), curved)
    for v, co in zip(me.vertices, sheet_states[0]):
        v.co = co

    # The ink on it: the same strokes as the page, folded with the paper.
    ibm = bmesh.new()
    reveal = []
    for stroke in strokes:
        p = stroke["pts"]
        prev = None
        for i, q in enumerate(p):
            a, b = p[max(i - 1, 0)], p[min(i + 1, len(p) - 1)]
            t = (b - a).normalized() if (b - a).length > 1e-9 else Vector((1, 0))
            n = Vector((-t.y, t.x)) * 0.0021 * (1.0 + 0.5 * max(0.0, -t.y))
            pair = (ibm.verts.new((q.x + n.x - cx, q.y + n.y, 0)), ibm.verts.new((q.x - n.x - cx, q.y - n.y, 0)))
            tt = stroke["t0"] + (stroke["t1"] - stroke["t0"]) * i / (len(p) - 1)
            reveal += [tt, tt]
            if prev:
                ibm.faces.new((prev[1], pair[1], pair[0], prev[0]))
            prev = pair
    ime = bpy.data.meshes.new("AirplaneInk")
    ibm.to_mesh(ime)
    ibm.free()
    ime.materials.append(m_ink)
    ink = bpy.data.objects.new("AirplaneInk", ime)
    bpy.context.scene.collection.objects.link(ink)
    ink.parent = plane_root
    ipts = [v.co.to_2d() for v in ime.vertices]
    icurved = [z_top(cx + p.x) + lift + 0.0004 + ink_lift - base_z for p in ipts]
    ink_states = fold.states(ipts, [ink_lift] * len(ipts), icurved)
    for v, co in zip(ime.vertices, ink_states[0]):
        v.co = co
    layer = ime.uv_layers.new(name="Reveal")   # see store_reveal in build_desk.py
    for loop in ime.loops:
        layer.data[loop.index].uv = (reveal[loop.vertex_index], 0.0)

    f0, f1 = fly_range
    _add_keys(sheet, sheet_states, f0, f1, fps)
    _add_keys(ink, ink_states, f0, f1, fps)

    # Flight: lift off, turn nose-left while folding, a breath, then away.
    plane_root.rotation_mode = "QUATERNION"
    start = Vector((cx, 0, base_z))
    # Over the left page: the pen hovers over the right one.
    hover = Vector((-0.38, 0.05, base_z + 0.55))
    nose_left = Quaternion((0, 0, 1), math.radians(90)) @ Quaternion((1, 0, 0), math.radians(-8))
    p0 = hover + Vector((0.12, 0, 0.05))
    p1 = p0 + Vector((-1.4, -0.2, 0.55))
    p2 = Vector((-3.2, -1.5, 1.6))
    p3 = Vector((-7.5, -2.6, 2.3))
    total = (f1 - f0) / fps

    def pose(t):
        if t < LAUNCH:
            k = min(t / 1.6, 1.0)
            k = k * k * (3 - 2 * k)
            loc = start.lerp(hover, k)
            rot = Quaternion().slerp(nose_left, k)
            if t > 1.6:
                # Drawn back a touch and nose up, the instant before the throw.
                b = (t - 1.6) / (LAUNCH - 1.6)
                b = b * b * (3 - 2 * b)
                loc = loc + Vector((0.12, 0, 0.05)) * b
                rot = rot @ Quaternion((1, 0, 0), math.radians(10) * b)
            return loc, rot
        u = (t - LAUNCH) / (total - LAUNCH)
        u = u ** 1.6                                   # accelerating away
        loc = _bezier(p0, p1, p2, p3, u)
        ahead = _bezier(p0, p1, p2, p3, min(u + 0.02, 1.0)) - _bezier(p0, p1, p2, p3, max(u - 0.02, 0.0))
        heading = ahead.normalized().to_track_quat("Y", "Z")
        bank = math.radians(28) * math.sin(math.pi * min(u * 1.4, 1.0))
        return loc, heading @ Quaternion((0, 1, 0), -bank)

    for frame in range(f0, f1 + 1):
        loc, rot = pose((frame - f0) / fps)
        plane_root.location = loc
        plane_root.rotation_quaternion = rot
        plane_root.keyframe_insert("location", frame=frame)
        plane_root.keyframe_insert("rotation_quaternion", frame=frame)
    # Before its clip it waits on the page, hidden by the app.
    plane_root.location, plane_root.rotation_quaternion = start, Quaternion()
    plane_root.keyframe_insert("location", frame=0)
    plane_root.keyframe_insert("rotation_quaternion", frame=0)
    plane_root.keyframe_insert("location", frame=f0 - 1)
    plane_root.keyframe_insert("rotation_quaternion", frame=f0 - 1)
    return plane_root

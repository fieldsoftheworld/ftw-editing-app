/**
 * Browser port of the FTW shape triage
 * (ftw-baselines: research/geometry/ftw_geometry/core/descriptors.py and
 * research/geometry/triage_descriptor_pilot.py, algorithm shape-triage-demo-0.1).
 *
 * Geometries are measured in the map projection (EPSG:3857). All descriptors
 * used for routing are scale-invariant ratios, so Web Mercator's (locally
 * uniform) scale factor cancels out. Absolute thresholds in metres are
 * evaluated with geodesic lengths from `ol/sphere`.
 *
 * Results are proposals only: exploratory, uncalibrated routes, not confirmed
 * errors. Nothing here changes input geometries.
 */
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import ConvexHull from 'jsts/org/locationtech/jts/algorithm/ConvexHull.js';
import SimplePointInAreaLocator from 'jsts/org/locationtech/jts/algorithm/locate/SimplePointInAreaLocator.js';
import Location from 'jsts/org/locationtech/jts/geom/Location.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import RelateOp from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import { getLength } from 'ol/sphere.js';
import { splitPolygonByLine } from '../geometry/splitPolygon.ts';
import LineString from 'ol/geom/LineString.js';
import type Polygon from 'ol/geom/Polygon.js';
import type MultiPolygon from 'ol/geom/MultiPolygon.js';

/** Same values as SETTINGS / NARROW_NECK_* in ftw-baselines. */
export const SETTINGS = {
  narrowNeckRadiusFraction: 0.1,
  narrowNeckComponentFraction: 0.02,
  erosionRadiusFractions: [0.025, 0.05, 0.075, 0.1, 0.125, 0.15],
  minimumErodedLobeParentAreaFraction: 0.02,
  // Exploratory strip screen, not a minimum width for a valid field.
  exclusionMaxRectangleWidthM: 25,
  exclusionMinElongation: 8,
  exclusionMaxCircularity: 0.25,
  minimumPreviewChildAreaFraction: 0.05,
  // At most this many cuts per field, one per distinct neck.
  maxNeckCuts: 6,
};

export type Outcome = 'exclude' | 'repair' | 'retain' | 'abstain';
export const OUTCOMES: readonly Outcome[] = ['exclude', 'repair', 'abstain', 'retain'];

export interface ShapeDescriptors {
  areaM2: number;
  perimeterM: number;
  circularity: number;
  elongation: number;
  solidity: number;
  rectangleLengthM: number;
  rectangleWidthM: number;
  rectangularity: number;
  convexHullIndex: number;
  holeCount: number;
  holeAreaFraction: number;
  orientationDeg: number;
  orientationAmbiguous: boolean;
  narrowNeck: boolean;
}

export interface ErosionStep {
  radiusFraction: number;
  distanceM: number;
  retainedLobeAreaFractions: number[];
}

/**
 * A validated cut across a narrow neck: the shortest one per neck, sorted shortest
 * first. Each cut is valid on its own; after applying one, the resulting fields
 * carry the remaining cuts (see `inheritedCuts` in triageField).
 */
export interface CutProposal {
  /** Cut chord in map coordinates. */
  line: number[][];
  /**
   * The two parts (polygon ring coordinates, map projection) that exactly
   * partition the field along the cut; validated, so applying them is safe.
   */
  parts: number[][][][];
  childAreaFractions: number[];
  lengthM: number;
}

export interface TriageResult {
  outcome: Outcome;
  reason: string;
  narrowNeck: boolean;
  descriptors?: ShapeDescriptors;
  erosionProfile?: ErosionStep[];
  cuts: CutProposal[];
}

// JSTS ships `any`-typed declarations. This is the subset used here.
interface JGeom {
  getArea(): number;
  getLength(): number;
  getNumGeometries(): number;
  getGeometryN(n: number): JGeom;
  getGeometryType(): string;
  getBoundary(): JGeom;
  getCoordinates(): Coordinate[];
  getEnvelopeInternal(): {
    getMinX(): number;
    getMinY(): number;
    getMaxX(): number;
    getMaxY(): number;
  };
  isEmpty(): boolean;
  getExteriorRing(): JGeom;
  getNumInteriorRing(): number;
  getInteriorRingN(n: number): JGeom;
}

const factory = new GeometryFactory();

type XY = [number, number];

function closeRing(ring: number[][], ox: number, oy: number): Coordinate[] {
  const coords = ring.map((c) => new Coordinate(c[0]! - ox, c[1]! - oy));
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first && last && !first.equals2D(last)) coords.push(new Coordinate(first.x, first.y));
  return coords;
}

function toJstsPolygon(rings: number[][][], ox: number, oy: number): JGeom {
  const [shell, ...holes] = rings.map((r) => factory.createLinearRing(closeRing(r, ox, oy)));
  return factory.createPolygon(shell, holes);
}

function parts(geom: JGeom): JGeom[] {
  const out: JGeom[] = [];
  for (let i = 0; i < geom.getNumGeometries(); i++) out.push(geom.getGeometryN(i));
  return out;
}

function line(coords: XY[]): JGeom {
  return factory.createLineString(coords.map(([x, y]) => new Coordinate(x, y)));
}

/** Geodesic length in metres of a straight local-coordinate segment. */
function metres(a: XY, b: XY, ox: number, oy: number): number {
  return getLength(
    new LineString([
      [a[0] + ox, a[1] + oy],
      [b[0] + ox, b[1] + oy],
    ]),
  );
}

/**
 * Minimum-area enclosing rectangle via rotating calipers over the convex hull.
 * Equivalent to shapely's minimum_rotated_rectangle (GEOS >= 3.12 oriented envelope).
 */
function minimumAreaRectangle(hull: JGeom): XY[] {
  const pts = hull.getCoordinates().map((c): XY => [c.x, c.y]);
  let best: { area: number; corners: XY[] } | undefined;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len === 0) continue;
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of pts) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const at = (u: number, v: number): XY => [u * ux - v * uy, u * uy + v * ux];
      best = {
        area,
        corners: [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV), at(minU, minV)],
      };
    }
  }
  if (!best || !(best.area > 0))
    throw new Error('Polygon has a degenerate minimum rotated rectangle');
  return best.corners;
}

function retainedLobes(poly: JGeom, fraction: number, componentFraction: number): JGeom[] {
  const area = poly.getArea();
  const distance = fraction * Math.sqrt(area / Math.PI);
  const eroded: JGeom = BufferOp.bufferOp(poly, -distance);
  return parts(eroded)
    .filter((p) => !p.isEmpty() && p.getArea() >= componentFraction * area)
    .sort((a, b) => b.getArea() - a.getArea());
}

interface Measured {
  descriptors: ShapeDescriptors;
  /** Map units per metre, for converting metre tolerances. */
  scale: number;
}

/** Port of polygon_descriptors(). `poly` is in local (offset) map coordinates. */
function describe(poly: JGeom, ox: number, oy: number): Measured {
  const area = poly.getArea();
  const perimeter = poly.getLength();
  const hull: JGeom = new ConvexHull(poly).getConvexHull();
  const corners = minimumAreaRectangle(hull);
  const sides = corners
    .slice(0, 4)
    .map((c, i) => Math.hypot(corners[i + 1]![0] - c[0], corners[i + 1]![1] - c[1]));
  const index = sides.indexOf(Math.max(...sides));
  const shortIndex = sides.indexOf(Math.min(...sides));
  const longSide = sides[index]!;
  const shortSide = sides[shortIndex]!;
  const longM = metres(corners[index]!, corners[index + 1]!, ox, oy);
  const shortM = metres(corners[shortIndex]!, corners[shortIndex + 1]!, ox, oy);
  const scale = longSide / longM;
  let holeArea = 0;
  for (let i = 0; i < poly.getNumInteriorRing(); i++) {
    holeArea += factory.createPolygon(poly.getInteriorRingN(i)).getArea();
  }
  const ambiguous = longSide / shortSide <= 1.05;
  const dx = corners[index + 1]![0] - corners[index]![0];
  const dy = corners[index + 1]![1] - corners[index]![1];
  // Axial angle counterclockwise from projected +x, not a true-north bearing.
  const orientation = ambiguous
    ? NaN
    : ((((Math.atan2(dy, dx) * 180) / Math.PI) % 180) + 180) % 180;
  const lobes = retainedLobes(
    poly,
    SETTINGS.narrowNeckRadiusFraction,
    SETTINGS.narrowNeckComponentFraction,
  );
  return {
    scale,
    descriptors: {
      areaM2: area / scale ** 2,
      perimeterM: perimeter / scale,
      circularity: (4 * Math.PI * area) / perimeter ** 2,
      elongation: longSide / shortSide,
      solidity: area / hull.getArea(),
      rectangleLengthM: longM,
      rectangleWidthM: shortM,
      rectangularity: area / (longSide * shortSide),
      convexHullIndex: hull.getLength() / perimeter,
      holeCount: poly.getNumInteriorRing(),
      holeAreaFraction: holeArea / (area + holeArea),
      orientationDeg: orientation,
      orientationAmbiguous: ambiguous,
      narrowNeck: lobes.length >= 2,
    },
  };
}

/** Port of erosion_profile(). */
function erosionProfile(poly: JGeom, scale: number): { profile: ErosionStep[]; lobes: JGeom[][] } {
  const area = poly.getArea();
  const radius = Math.sqrt(area / Math.PI);
  const profile: ErosionStep[] = [];
  const lobes: JGeom[][] = [];
  for (const fraction of SETTINGS.erosionRadiusFractions) {
    const retained = retainedLobes(poly, fraction, SETTINGS.minimumErodedLobeParentAreaFraction);
    profile.push({
      radiusFraction: fraction,
      distanceM: (fraction * radius) / scale,
      retainedLobeAreaFractions: retained.map((p) => p.getArea() / area),
    });
    lobes.push(retained);
  }
  return { profile, lobes };
}

/** Area of polygon rings (exterior minus holes), shoelace formula. */
function ringsArea(rings: number[][][]): number {
  const ringArea = (r: number[][]) => {
    let sum = 0;
    for (let i = 0; i < r.length - 1; i++)
      sum += r[i]![0]! * r[i + 1]![1]! - r[i + 1]![0]! * r[i]![1]!;
    return Math.abs(sum) / 2;
  };
  return rings.reduce((total, r, i) => total + (i === 0 ? 1 : -1) * ringArea(r), 0);
}

function lineLength(line: number[][]): number {
  let length = 0;
  for (let i = 0; i < line.length - 1; i++) {
    length += Math.hypot(line[i + 1]![0]! - line[i]![0]!, line[i + 1]![1]! - line[i]![1]!);
  }
  return length;
}

/**
 * The two parts a cut splits the field into (exact, validated split from the
 * split tool's module), or null when it does not cleanly split the field into
 * two parts that each have at least the minimum child area fraction.
 */
function cutParts(rings: number[][][], cut: number[][]): number[][][][] | null {
  const parts = splitPolygonByLine(rings, cut);
  if (!parts || parts.length !== 2) return null;
  const areas = parts.map(ringsArea);
  const total = areas[0]! + areas[1]!;
  if (Math.min(...areas) < SETTINGS.minimumPreviewChildAreaFraction * total) return null;
  return parts;
}

/**
 * Whether two cuts (map coordinates) cross the same neck: they touch, or the
 * strip between them is negligible (less than the minimum child area fraction of
 * the field). Cuts across different necks each split off a substantial part.
 */
function sameNeck(rings: number[][][], a: number[][], b: number[][]): boolean {
  try {
    const toLine = (l: number[][]) =>
      factory.createLineString(l.map(([x, y]) => new Coordinate(x!, y!)));
    if (RelateOp.intersects(toLine(a), toLine(b))) return true;
  } catch {
    return true;
  }
  const area = ringsArea(rings);
  for (const piece of splitPolygonByLine(rings, a) ?? []) {
    const pieces = splitPolygonByLine(piece, b);
    if (!pieces) continue;
    if (pieces.length !== 2) return true;
    return (
      Math.min(ringsArea(pieces[0]!), ringsArea(pieces[1]!)) <
      SETTINGS.minimumPreviewChildAreaFraction * area
    );
  }
  return true;
}

/** Keep the shortest cut per neck, shortest first. */
function onePerNeck(rings: number[][][], cuts: number[][][]): number[][][] {
  const selected: number[][][] = [];
  for (const cut of [...cuts].sort((x, y) => lineLength(x) - lineLength(y))) {
    if (selected.some((old) => sameNeck(rings, cut, old))) continue;
    selected.push(cut);
    if (selected.length === SETTINGS.maxNeckCuts) break;
  }
  return selected;
}

/**
 * The component of (probe line ∩ field) that contains the probe's midpoint, as in
 * cut_alternatives(), computed without an overlay operation: the probe's
 * crossings with the field's rings are intersected arithmetically, and each
 * stretch between consecutive crossings is classified with a robust
 * point-in-polygon test. Returns null when the midpoint is outside the field.
 */
function chordThrough(poly: JGeom, from: XY, to: XY): XY[] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSq = dx * dx + dy * dy;
  const ts = [0, 1];
  const rings = [poly.getExteriorRing()];
  for (let i = 0; i < poly.getNumInteriorRing(); i++) rings.push(poly.getInteriorRingN(i));
  for (const ring of rings) {
    const coords = ring.getCoordinates();
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const qx = a.x - from[0];
      const qy = a.y - from[1];
      const den = dx * ey - dy * ex;
      if (den === 0) {
        // Parallel; if collinear, the probe runs along this edge.
        if (qx * dy - qy * dx === 0) {
          ts.push(
            (qx * dx + qy * dy) / lengthSq,
            ((b.x - from[0]) * dx + (b.y - from[1]) * dy) / lengthSq,
          );
        }
        continue;
      }
      const t = (qx * ey - qy * ex) / den;
      const u = (qx * dy - qy * dx) / den;
      if (u >= 0 && u <= 1 && t >= 0 && t <= 1) ts.push(t);
    }
  }
  const sorted = [...new Set(ts.filter((t) => t >= 0 && t <= 1))].sort((x, y) => x - y);
  const at = (t: number): XY => [from[0] + t * dx, from[1] + t * dy];
  const inside = sorted.slice(0, -1).map((t, k) => {
    const [x, y] = at((t + sorted[k + 1]!) / 2);
    return (
      SimplePointInAreaLocator.locatePointInPolygon(new Coordinate(x, y), poly) !==
      Location.EXTERIOR
    );
  });
  const k = sorted.findIndex((t, i) => i < sorted.length - 1 && t <= 0.5 && sorted[i + 1]! >= 0.5);
  if (k < 0 || !inside[k]) return null;
  let lo = k;
  let hi = k;
  while (lo > 0 && inside[lo - 1]) lo--;
  while (hi < inside.length - 1 && inside[hi + 1]) hi++;
  return [at(sorted[lo]!), at(sorted[hi + 1]!)];
}

/**
 * Port of validate_cut() for a candidate chord, without overlay operations: the
 * chord must split the field into two parts (exact, validated split, each part at
 * least the minimum child area fraction), and the two eroded cores it separates
 * must each lie entirely within a different part.
 */
function validateCut(
  rings: number[][][],
  ox: number,
  oy: number,
  cut: number[][],
  lobeA: JGeom,
  lobeB: JGeom,
): boolean {
  const parts = cutParts(rings, cut);
  if (!parts) return false;
  const polys = parts.map((part) => toJstsPolygon(part, ox, oy));
  const owner = (lobe: JGeom) => polys.findIndex((part) => RelateOp.covers(part, lobe));
  const a = owner(lobeA);
  const b = owner(lobeB);
  return a >= 0 && b >= 0 && a !== b;
}

/**
 * Port of cut_alternatives(): local cross-neck chords between eroded lobes.
 *
 * Returns all validated candidate chords; triageField keeps the shortest per neck.
 * Deviations from the Python pilot, so that fields with several necks can be
 * repaired one neck at a time: chords that cross any eroded core are skipped
 * (Python only checks the two cores being separated), and instead of the three
 * shortest distinct chords, the shortest chord per neck is kept.
 */
function cutAlternatives(
  poly: JGeom,
  rings: number[][][],
  ox: number,
  oy: number,
  lobes: JGeom[][],
): number[][][] {
  const found: number[][][] = [];
  const env = poly.getEnvelopeInternal();
  const span = Math.hypot(env.getMaxX() - env.getMinX(), env.getMaxY() - env.getMinY()) * 2;
  const tinyBuffer: JGeom = BufferOp.bufferOp(poly, 1e-7);
  for (const lobeSet of lobes) {
    // Complex multi-lobe cases remain visible but have bounded proposal work.
    if (lobeSet.length < 2 || lobeSet.length > 4) continue;
    for (let i = 0; i < lobeSet.length; i++) {
      for (let j = i + 1; j < lobeSet.length; j++) {
        const a = lobeSet[i]!;
        const b = lobeSet[j]!;
        const [p, q] = DistanceOp.nearestPoints(a, b) as [Coordinate, Coordinate];
        const connector = line([
          [p.x, p.y],
          [q.x, q.y],
        ]);
        if (connector.getLength() === 0 || !RelateOp.covers(tinyBuffer, connector)) continue;
        const norm = Math.hypot(q.x - p.x, q.y - p.y);
        const nx = -(q.y - p.y) / norm;
        const ny = (q.x - p.x) / norm;
        for (const position of [0.25, 0.5, 0.75]) {
          const mx = p.x + (q.x - p.x) * position;
          const my = p.y + (q.y - p.y) * position;
          const chord = chordThrough(
            poly,
            [mx - span * nx, my - span * ny],
            [mx + span * nx, my + span * ny],
          );
          if (!chord) continue;
          try {
            if (lobeSet.some((lobe) => RelateOp.intersects(line(chord), lobe))) continue;
            const cut = chord.map(([x, y]) => [x + ox, y + oy]);
            if (validateCut(rings, ox, oy, cut, a, b)) found.push(cut);
          } catch {
            // Robustness failure for this chord only: skip it.
          }
        }
      }
    }
  }
  return found;
}

/**
 * Port of classify(), without the study-specific review seeds and without the
 * study's 100 m window-edge context rule: that rule guarded against fields
 * truncated by the study's saved extracts, while imported fields here are complete.
 */
function classify(d: ShapeDescriptors, profile: ErosionStep[], hasCut: boolean): [Outcome, string] {
  const thin =
    d.rectangleWidthM <= SETTINGS.exclusionMaxRectangleWidthM &&
    d.elongation >= SETTINGS.exclusionMinElongation &&
    d.circularity < SETTINGS.exclusionMaxCircularity;
  if (thin) {
    return [
      'exclude',
      'Very thin elongated shape: possibly not a field, but may be a valid narrow field.',
    ];
  }
  if (d.narrowNeck) {
    const counts = profile.map((p) => p.retainedLobeAreaFractions.length);
    if (hasCut && counts.filter((c) => c === 2).length >= 3 && Math.max(...counts) === 2) {
      return ['repair', 'Persistent two-lobe shape with a geometric cut: possibly joined fields.'];
    }
    return ['abstain', 'Narrow neck is scale-sensitive or complex; no simple supported cut.'];
  }
  return ['retain', 'No shape rule triggered.'];
}

function abstain(reason: string): TriageResult {
  return {
    outcome: 'abstain',
    reason,
    narrowNeck: false,
    cuts: [],
  };
}

/** Whether a field intersects the window (both in map coordinates). */
export function intersectsWindow(geometry: Polygon | MultiPolygon, window: Polygon): boolean {
  const ext = window.getExtent();
  const [ox, oy] = [ext[0]!, ext[1]!];
  try {
    const win = toJstsPolygon(window.getCoordinates(), ox, oy);
    const polys =
      geometry.getType() === 'Polygon'
        ? [(geometry as Polygon).getCoordinates()]
        : (geometry as MultiPolygon).getCoordinates();
    return polys.some((rings) => RelateOp.intersects(win, toJstsPolygon(rings, ox, oy)));
  } catch {
    return geometry.intersectsExtent(ext);
  }
}

/**
 * Triage a single field. The geometry must be in EPSG:3857.
 *
 * `inheritedCuts` are suggested cut lines of the field this one was split from.
 * Those that still validly split this field are kept, so that a field with
 * several necks can be repaired one cut at a time, even when this smaller field
 * would no longer be flagged on its own (the neck test is relative to field size).
 */
export function triageField(
  geometry: Polygon | MultiPolygon,
  inheritedCuts: number[][][] = [],
): TriageResult {
  let rings: number[][][];
  if (geometry.getType() === 'MultiPolygon') {
    const polys = (geometry as MultiPolygon).getCoordinates();
    if (polys.length !== 1) return abstain('Multipart feature: review it as a whole.');
    rings = polys[0]!;
  } else {
    rings = (geometry as Polygon).getCoordinates();
  }
  if (rings.length === 0 || rings.some((r) => r.length < 3)) return abstain('Invalid geometry.');

  // Avoid large-coordinate cancellation: work relative to the field's lower-left corner.
  const ext = geometry.getExtent();
  const [ox, oy] = [ext[0]!, ext[1]!];
  try {
    const poly = toJstsPolygon(rings, ox, oy);
    if (poly.isEmpty() || !IsValidOp.isValid(poly) || !(poly.getArea() > 0)) {
      return abstain('Invalid geometry.');
    }
    const { descriptors, scale } = describe(poly, ox, oy);

    const { profile, lobes } = erosionProfile(poly, scale);
    const candidates = descriptors.narrowNeck ? cutAlternatives(poly, rings, ox, oy, lobes) : [];
    let [outcome, reason] = classify(descriptors, profile, candidates.length > 0);

    // Neck grouping, inherited cuts and the final parts all use the exact split
    // module, working in map coordinates on the original rings.
    const own = onePerNeck(rings, candidates);
    const inherited = inheritedCuts
      .filter((cut) => cutParts(rings, cut))
      .filter((cut) => !own.some((o) => sameNeck(rings, cut, o)));
    if (inherited.length > 0 && outcome === 'retain') {
      outcome = 'repair';
      reason = 'Remaining neck of a field that was split: possibly joined fields.';
    }

    const cuts: CutProposal[] = onePerNeck(rings, [...own, ...inherited]).flatMap((cut) => {
      const parts = cutParts(rings, cut);
      if (!parts) return [];
      const areas = parts.map(ringsArea);
      const total = areas[0]! + areas[1]!;
      return [
        {
          line: cut,
          parts,
          childAreaFractions: areas.map((a) => a / total).sort((x, y) => x - y),
          lengthM: getLength(new LineString(cut)),
        },
      ];
    });
    return {
      outcome,
      reason,
      narrowNeck: descriptors.narrowNeck,
      descriptors,
      erosionProfile: profile,
      cuts,
    };
  } catch {
    // JSTS TopologyException and similar robustness failures.
    return abstain('Geometry could not be analysed.');
  }
}

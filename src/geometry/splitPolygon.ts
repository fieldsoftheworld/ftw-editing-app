/**
 * Exact polygon splitting along a (poly)line with JSTS.
 *
 * The polygon boundary and the line are noded together with snap rounding on a
 * 1 µm grid, so that intersections, line ends placed on the boundary and line
 * sections running along boundary edges meet exactly. The noded edges are
 * polygonized, and the faces inside the polygon are the parts. Snapped
 * coordinates are then restored to the exact input vertices they stand for.
 *
 * Unlike a difference with a thin buffer around the line followed by snapping,
 * the parts share identical edges along the line. Every result is checked to be
 * valid and to partition the polygon; otherwise no split is returned. Line ends
 * that do not cross the boundary are dangles and are ignored.
 */
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import RelateOp from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import GeometryNoder from 'jsts/org/locationtech/jts/noding/snapround/GeometryNoder.js';
import ArrayList from 'jsts/java/util/ArrayList.js';

// JSTS ships `any`-typed declarations. This is the subset used here.
interface JGeom {
  getArea(): number;
  getLength(): number;
  getCoordinates(): Coordinate[];
  getExteriorRing(): JGeom;
  getNumInteriorRing(): number;
  getInteriorRingN(n: number): JGeom;
}

const factory = new GeometryFactory();

/** Snap-rounding grid: 1e6 cells per map unit, i.e. 1 µm (local coordinates). */
const GRID_SCALE = 1e6;
/** Distance within which a noded coordinate is restored to an input vertex. */
const RESTORE_TOLERANCE = 1e-6;
/** Faces smaller than this (map units²) are numerical slivers, not parts. */
const MIN_PART_AREA = 1e-6;
/**
 * Line ends that are not on a boundary vertex are extended by this much (0.1 mm),
 * so that an end placed on the boundary (e.g. snapped to an edge) properly
 * crosses it. The extension beyond the boundary is a dangle and is ignored.
 */
const END_EXTENSION = 1e-4;

/**
 * Prepare the line's ends: an end on (or within the restore tolerance of) a
 * boundary vertex is set to exactly that vertex, so that it coincides with it
 * after grid rounding; any other end is extended slightly, so that it crosses
 * the boundary rather than ending on it.
 */
function prepareEnds(coords: Coordinate[], vertices: Coordinate[]): Coordinate[] {
  const atVertex = (c: Coordinate) =>
    vertices.find(
      (v) => Math.abs(v.x - c.x) <= RESTORE_TOLERANCE && Math.abs(v.y - c.y) <= RESTORE_TOLERANCE,
    );
  const end = (from: Coordinate, to: Coordinate) => {
    const vertex = atVertex(to);
    if (vertex) return new Coordinate(vertex.x, vertex.y);
    const length = from.distance(to);
    if (length === 0) return to;
    const f = END_EXTENSION / length;
    return new Coordinate(to.x + (to.x - from.x) * f, to.y + (to.y - from.y) * f);
  };
  const n = coords.length;
  return [end(coords[1]!, coords[0]!), ...coords.slice(1, -1), end(coords[n - 2]!, coords[n - 1]!)];
}

function ring(coords: number[][], ox: number, oy: number): JGeom {
  const points = coords.map((c) => new Coordinate(c[0]! - ox, c[1]! - oy));
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && !first.equals2D(last)) points.push(new Coordinate(first.x, first.y));
  return factory.createLinearRing(points);
}

/**
 * A part's rings, with coordinates within the tolerance of an input vertex
 * restored to that exact vertex, and consecutive duplicates removed. Holes that
 * collapse are dropped.
 */
function cleanRings(poly: JGeom, vertices: Coordinate[]): number[][][] {
  const restore = (c: Coordinate): number[] => {
    for (const v of vertices) {
      if (Math.abs(v.x - c.x) <= RESTORE_TOLERANCE && Math.abs(v.y - c.y) <= RESTORE_TOLERANCE) {
        return [v.x, v.y];
      }
    }
    return [c.x, c.y];
  };
  const clean = (r: JGeom): number[][] => {
    const out: number[][] = [];
    for (const c of r.getCoordinates().map(restore)) {
      const prev = out[out.length - 1];
      if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) out.push(c);
    }
    return out;
  };
  const rings = [clean(poly.getExteriorRing())];
  for (let i = 0; i < poly.getNumInteriorRing(); i++) rings.push(clean(poly.getInteriorRingN(i)));
  return rings.filter((r, i) => i === 0 || r.length >= 4);
}

/**
 * Node lines with snap rounding and return their unique non-degenerate segments.
 * Snap rounding requires its input on the grid, so coordinates are rounded first
 * (cleanRings later restores the exact input vertices).
 */
function nodedSegments(lines: Coordinate[][]): JGeom[] {
  const input = new ArrayList(lines.length);
  const round = (v: number) => Math.round(v * GRID_SCALE) / GRID_SCALE;
  for (const line of lines) {
    const rounded: Coordinate[] = [];
    for (const c of line) {
      const r = new Coordinate(round(c.x), round(c.y));
      if (!rounded.length || !rounded[rounded.length - 1]!.equals2D(r)) rounded.push(r);
    }
    if (rounded.length >= 2) input.add(factory.createLineString(rounded));
  }
  const noded: JGeom[] = new GeometryNoder(new PrecisionModel(GRID_SCALE)).node(input).toArray();
  const seen = new Set<string>();
  const segments: JGeom[] = [];
  for (const line of noded) {
    const coords = line.getCoordinates();
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      if (a.equals2D(b)) continue;
      // Line sections along boundary edges produce duplicate segments.
      const key =
        a.x < b.x || (a.x === b.x && a.y < b.y)
          ? `${a.x},${a.y},${b.x},${b.y}`
          : `${b.x},${b.y},${a.x},${a.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push(factory.createLineString([a, b]));
    }
  }
  return segments;
}

/**
 * Split a polygon (ring coordinates) along a line, both in the same projected
 * coordinates. Returns the parts, or null when the line does not split the
 * polygon, the polygon is invalid, or no valid exact partition results.
 */
export function splitPolygonByLine(rings: number[][][], line: number[][]): number[][][][] | null {
  // Remove consecutive duplicate vertices from the line.
  const coords = line.filter(
    (c, i) => i === 0 || c[0] !== line[i - 1]![0] || c[1] !== line[i - 1]![1],
  );
  if (coords.length < 2 || rings.length === 0) return null;
  // Work relative to a local origin, so the 1 µm grid is representable with
  // ample precision (projected coordinates are ~1e7).
  const [ox, oy] = [rings[0]![0]![0]!, rings[0]![0]![1]!];
  try {
    const [shell, ...holes] = rings.map((r) => ring(r, ox, oy));
    const poly: JGeom = factory.createPolygon(shell, holes);
    if (!IsValidOp.isValid(poly)) return null;
    const lineCoords = coords.map((c) => new Coordinate(c[0]! - ox, c[1]! - oy));
    const splitter: JGeom = factory.createLineString(
      prepareEnds(lineCoords, poly.getCoordinates()),
    );

    const polygonizer = new Polygonizer();
    const ringCoords = [poly.getExteriorRing().getCoordinates()];
    for (let i = 0; i < poly.getNumInteriorRing(); i++) {
      ringCoords.push(poly.getInteriorRingN(i).getCoordinates());
    }
    for (const segment of nodedSegments([...ringCoords, splitter.getCoordinates()])) {
      polygonizer.add(segment);
    }
    const faces: JGeom[] = polygonizer.getPolygons().toArray();
    const vertices = [...poly.getCoordinates(), ...lineCoords];
    const parts = faces
      .filter(
        (face) =>
          face.getArea() > MIN_PART_AREA &&
          RelateOp.contains(poly, factory.createPoint(InteriorPointArea.getInteriorPoint(face))),
      )
      .map((face) => cleanRings(face, vertices))
      .filter((partRings) => partRings[0]!.length >= 4);
    if (parts.length < 2) return null;

    // Final guarantee: only return valid parts that partition the polygon. New
    // nodes on the boundary may be off by up to the grid size, hence the tolerance.
    const jstsParts: JGeom[] = parts.map((partRings) => {
      const [partShell, ...partHoles] = partRings.map((r) => ring(r, 0, 0));
      return factory.createPolygon(partShell, partHoles);
    });
    if (!jstsParts.every((part) => IsValidOp.isValid(part))) return null;
    const area = poly.getArea();
    const total = jstsParts.reduce((sum, part) => sum + part.getArea(), 0);
    const tolerance = area * 1e-9 + (poly.getLength() + splitter.getLength()) / GRID_SCALE;
    if (Math.abs(total - area) > tolerance) return null;

    return parts.map((partRings) => partRings.map((r) => r.map(([x, y]) => [x! + ox, y! + oy])));
  } catch {
    // JSTS TopologyException and similar robustness failures: leave unsplit.
    return null;
  }
}

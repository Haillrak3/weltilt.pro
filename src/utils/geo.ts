import { DELIVERY_ZONES, type DeliveryZone } from '../data/zones';

const LAT_KM = 111;
const LON_KM = 111 * Math.cos(55.65 * (Math.PI / 180)); // ≈62.6 for Moscow

function distancePtKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dx = (lon2 - lon1) * LON_KM;
  const dy = (lat2 - lat1) * LAT_KM;
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToSegmentKm(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dax = (bx - ax) * LON_KM, day = (by - ay) * LAT_KM;
  const len2 = dax * dax + day * day;
  if (len2 === 0) return distancePtKm(px, py, ax, ay);
  const t = Math.max(0, Math.min(1, (((px - ax) * LON_KM) * dax + ((py - ay) * LAT_KM) * day) / len2));
  return distancePtKm(px, py, ax + t * (bx - ax), ay + t * (by - ay));
}

function distanceToPolygonKm(lon: number, lat: number, polygon: [number, number][]): number {
  let min = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const d = distanceToSegmentKm(lon, lat, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]);
    if (d < min) min = d;
  }
  return min;
}

function pointInPolygon(lon: number, lat: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function detectZones(lon: number, lat: number): DeliveryZone[] {
  return DELIVERY_ZONES.filter((z) => pointInPolygon(lon, lat, z.polygon));
}

export interface NearestZoneResult {
  zone: DeliveryZone;
  distanceKm: number;
}

export function nearestZone(lon: number, lat: number): NearestZoneResult {
  let best: NearestZoneResult = { zone: DELIVERY_ZONES[0], distanceKm: Infinity };
  for (const z of DELIVERY_ZONES) {
    const d = distanceToPolygonKm(lon, lat, z.polygon);
    if (d < best.distanceKm) best = { zone: z, distanceKm: d };
  }
  return best;
}

export async function geocodeAddress(street: string, house: string): Promise<{ lon: number; lat: number } | null> {
  if (!street || !house) return null;
  const q = encodeURIComponent(`Москва, ${street}, ${house}`);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=ru&bounded=1&viewbox=37.55,55.73,37.86,55.57`,
      { headers: { 'Accept-Language': 'ru', 'User-Agent': 'OrderDesk/1.0' } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    return { lon: parseFloat(data[0].lon), lat: parseFloat(data[0].lat) };
  } catch {
    return null;
  }
}

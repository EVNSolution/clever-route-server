import { deflateSync } from 'node:zlib';

import type { DriverAssignedRoute, DriverAssignedRouteStopPoint } from './driver-assigned-route.types.js';

export const DRIVER_ROUTE_MAP_PREVIEW_RENDERER_VERSION = 'pure-ts-png-v1';
export const DRIVER_ROUTE_MAP_PREVIEW_WIDTH = 720;
export const DRIVER_ROUTE_MAP_PREVIEW_HEIGHT = 430;

type Rgba = [number, number, number, number];
type Point = { x: number; y: number };
type Bounds = {
  maxLat: number;
  maxLng: number;
  minLat: number;
  minLng: number;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_BACKGROUND: Rgba = [243, 248, 251, 255];
const COLOR_GRID: Rgba = [222, 233, 240, 255];
const COLOR_ROUTE: Rgba = [11, 87, 208, 255];
const COLOR_MARKER: Rgba = [11, 87, 208, 255];
const COLOR_MARKER_STROKE: Rgba = [255, 255, 255, 255];
const COLOR_TEXT: Rgba = [255, 255, 255, 255];

export function renderDriverRouteMapPreviewPng(route: DriverAssignedRoute): Buffer | null {
  const bounds = readBounds(route);
  if (bounds === null) {
    return null;
  }
  const routeGeometry = route.routeGeometry;
  if (routeGeometry === null) {
    return null;
  }

  const canvas = new RgbaCanvas(DRIVER_ROUTE_MAP_PREVIEW_WIDTH, DRIVER_ROUTE_MAP_PREVIEW_HEIGHT, COLOR_BACKGROUND);
  drawGrid(canvas);

  const project = createProjector(bounds, canvas.width, canvas.height);
  const routePoints = routeGeometry.coordinates.map(([lng, lat]) => project(lng, lat));
  for (let index = 1; index < routePoints.length; index += 1) {
    const previous = routePoints[index - 1];
    const current = routePoints[index];
    if (previous !== undefined && current !== undefined) {
      canvas.drawLine(previous, current, COLOR_ROUTE, 8);
    }
  }

  const stopPoints = route.routeStopPoints.length > 0
    ? route.routeStopPoints
    : route.stops.map((stop): DriverAssignedRouteStopPoint => ({
        deliveryStopId: stop.deliveryStopId,
        inputCoordinates: readStopCoordinates(stop.coordinates),
        name: null,
        sequence: stop.sequence,
        snapDistanceMeters: null,
        snappedCoordinates: null
      }));

  const orderedStopPoints = [...stopPoints].sort((left, right) => left.sequence - right.sequence);
  for (const stopPoint of orderedStopPoints) {
    const coordinates = stopPoint.snappedCoordinates ?? stopPoint.inputCoordinates;
    if (coordinates === null) continue;
    const markerPoint = project(coordinates[0], coordinates[1]);
    drawMarker(canvas, markerPoint, stopPoint.sequence);
  }

  return encodePng(canvas);
}

function readStopCoordinates(
  coordinates: DriverAssignedRoute['stops'][number]['coordinates']
): [number, number] | null {
  if (coordinates.longitude === null || coordinates.latitude === null) {
    return null;
  }
  return [coordinates.longitude, coordinates.latitude];
}

export function hasRenderableDriverRouteMapPreview(route: DriverAssignedRoute): boolean {
  return readBounds(route) !== null;
}

function readBounds(route: DriverAssignedRoute): Bounds | null {
  if (route.routeGeometry === null || route.routeGeometry.coordinates.length < 2) {
    return null;
  }

  const coordinates: [number, number][] = [...route.routeGeometry?.coordinates ?? []];
  for (const stopPoint of route.routeStopPoints) {
    if (stopPoint.snappedCoordinates !== null) coordinates.push(stopPoint.snappedCoordinates);
    if (stopPoint.inputCoordinates !== null) coordinates.push(stopPoint.inputCoordinates);
  }

  const finiteCoordinates = coordinates.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (finiteCoordinates.length < 2) {
    return null;
  }

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of finiteCoordinates) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (maxLng - minLng < 0.00001 || maxLat - minLat < 0.00001) {
    return null;
  }

  return { maxLat, maxLng, minLat, minLng };
}

function createProjector(bounds: Bounds, width: number, height: number): (lng: number, lat: number) => Point {
  const padding = 52;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  return (lng, lat) => ({
    x: padding + ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * usableWidth,
    y: padding + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * usableHeight
  });
}

function drawGrid(canvas: RgbaCanvas): void {
  for (let x = 40; x < canvas.width; x += 80) {
    canvas.drawLine({ x, y: 0 }, { x: x + 42, y: canvas.height }, COLOR_GRID, 2);
  }
  for (let y = 45; y < canvas.height; y += 85) {
    canvas.drawLine({ x: 0, y }, { x: canvas.width, y: y - 35 }, COLOR_GRID, 2);
  }
}

function drawMarker(canvas: RgbaCanvas, point: Point, sequence: number): void {
  canvas.fillCircle(point, 19, COLOR_MARKER_STROKE);
  canvas.fillCircle(point, 15, COLOR_MARKER);
  drawNumber(canvas, Math.max(0, Math.min(99, sequence)), point, COLOR_TEXT);
}

const DIGITS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111']
};

function drawNumber(canvas: RgbaCanvas, value: number, center: Point, color: Rgba): void {
  const text = String(value);
  const scale = text.length > 1 ? 3 : 4;
  const digitWidth = 3 * scale;
  const digitHeight = 5 * scale;
  const gap = scale;
  const totalWidth = text.length * digitWidth + (text.length - 1) * gap;
  let startX = Math.round(center.x - totalWidth / 2);
  const startY = Math.round(center.y - digitHeight / 2);
  for (const character of text) {
    const pattern = DIGITS[character];
    if (pattern !== undefined) {
      drawDigit(canvas, pattern, startX, startY, scale, color);
    }
    startX += digitWidth + gap;
  }
}

function drawDigit(canvas: RgbaCanvas, pattern: readonly string[], x: number, y: number, scale: number, color: Rgba): void {
  for (let row = 0; row < pattern.length; row += 1) {
    const line = pattern[row];
    if (line === undefined) continue;
    for (let column = 0; column < line.length; column += 1) {
      if (line[column] === '1') {
        canvas.fillRect(x + column * scale, y + row * scale, scale, scale, color);
      }
    }
  }
}

class RgbaCanvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgba
  ) {
    this.data = new Uint8Array(width * height * 4);
    for (let index = 0; index < this.data.length; index += 4) {
      this.data[index] = background[0];
      this.data[index + 1] = background[1];
      this.data[index + 2] = background[2];
      this.data[index + 3] = background[3];
    }
  }

  drawLine(start: Point, end: Point, color: Rgba, thickness: number): void {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      this.fillCircle({ x: start.x + dx * t, y: start.y + dy * t }, thickness / 2, color);
    }
  }

  fillCircle(center: Point, radius: number, color: Rgba): void {
    const minX = Math.floor(center.x - radius);
    const maxX = Math.ceil(center.x + radius);
    const minY = Math.floor(center.y - radius);
    const maxY = Math.ceil(center.y + radius);
    const radiusSquared = radius * radius;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - center.x;
        const dy = y - center.y;
        if (dx * dx + dy * dy <= radiusSquared) {
          this.setPixel(x, y, color);
        }
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number, color: Rgba): void {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        this.setPixel(column, row, color);
      }
    }
  }

  private setPixel(x: number, y: number, color: Rgba): void {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if (roundedX < 0 || roundedX >= this.width || roundedY < 0 || roundedY >= this.height) {
      return;
    }
    const offset = (roundedY * this.width + roundedX) * 4;
    this.data[offset] = color[0];
    this.data[offset + 1] = color[1];
    this.data[offset + 2] = color[2];
    this.data[offset + 3] = color[3];
  }
}

function encodePng(canvas: RgbaCanvas): Buffer {
  const rawRows: Buffer[] = [];
  for (let y = 0; y < canvas.height; y += 1) {
    rawRows.push(Buffer.from([0]));
    const start = y * canvas.width * 4;
    const end = start + canvas.width * 4;
    rawRows.push(Buffer.from(canvas.data.slice(start, end)));
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', createIhdr(canvas.width, canvas.height)),
    pngChunk('IDAT', deflateSync(Buffer.concat(rawRows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function createIhdr(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

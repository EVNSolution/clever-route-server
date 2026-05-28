type ProtocolConstructor = new (options?: { metadata?: boolean }) => { tile: unknown };

type MapLibreProtocolApi = {
  addProtocol(name: string, handler: unknown): void;
};

declare global {
  interface Window {
    __cleverRouteOpsPmtilesProtocolInstalled?: boolean;
  }
}

export function installPmtilesProtocol(maplibregl: MapLibreProtocolApi | null | undefined, Protocol: ProtocolConstructor | null | undefined): boolean {
  if (typeof window === 'undefined' || maplibregl === null || maplibregl === undefined || Protocol === null || Protocol === undefined) return false;
  if (window.__cleverRouteOpsPmtilesProtocolInstalled === true) return false;
  const protocol = new Protocol({ metadata: true });
  maplibregl.addProtocol('pmtiles', protocol.tile);
  window.__cleverRouteOpsPmtilesProtocolInstalled = true;
  return true;
}

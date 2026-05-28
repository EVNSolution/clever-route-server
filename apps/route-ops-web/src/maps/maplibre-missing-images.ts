type MapLike = {
  addImage?(id: string, image: ImageData): void;
  hasImage?(id: string): boolean;
  on?(eventName: 'styleimagemissing', handler: (event: { id?: string }) => void): void;
};

export function installMissingMapImageFallback(map: MapLike): void {
  map.on?.('styleimagemissing', (event) => {
    const id = event.id;
    if (id === undefined || map.hasImage?.(id)) return;
    map.addImage?.(id, createTransparentImage());
  });
}

function createTransparentImage(): ImageData {
  return new ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1);
}

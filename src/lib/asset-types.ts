export const assetTypes = [
  { value: 'media', label: 'Photos & videos' },
  { value: 'gifs', label: 'GIFs' },
  { value: 'audio', label: 'Audio' },
  { value: 'file', label: 'Files' },
  { value: 'links', label: 'Links' },
] as const
export type AssetType = typeof assetTypes[number]['value']

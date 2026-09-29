import { ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import type { AssetIndex, ProfilePicture } from '../lib/archive'
import { identifyMedia } from '../lib/media'

export function useProfilePicture(picture: MaybeRefOrGetter<ProfilePicture | undefined>, assets: MaybeRefOrGetter<AssetIndex>) {
  const url = ref('')
  watch(() => [toValue(picture), toValue(assets)] as const, async ([reference, index], _, cleanup) => {
    url.value = ''
    let current = true
    let objectUrl = ''
    cleanup(() => { current = false; if (objectUrl) URL.revokeObjectURL(objectUrl) })
    if (!reference) return
    const file = index.resolve(reference.uri, reference.directory)
    if (!file) return
    try {
      if (await identifyMedia(file, 'image') !== 'image' || !current) return
      objectUrl = URL.createObjectURL(file)
      url.value = objectUrl
    } catch { /* Keep initials when the local picture cannot be read. */ }
  }, { immediate: true })
  return url
}

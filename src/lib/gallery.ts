import type { AssetIndex, Attachment, Conversation, Message } from './archive'

export interface VisualAsset {
  id: string
  message: Message
  attachment: Attachment
}
export interface GallerySelection { items: VisualAsset[]; index: number }

export function isVisual(attachment: Attachment): boolean {
  return attachment.kind === 'image' || attachment.kind === 'video'
}

export function conversationGallery(conversation: Conversation, assets: AssetIndex): VisualAsset[] {
  return conversation.messages.flatMap(message => message.attachments.flatMap((attachment, index) =>
    isVisual(attachment) && (attachment.remote || assets.resolve(attachment.uri, message.sourceDirectory))
      ? [{ id: `${message.id}-${index}`, message, attachment }] : [],
  ))
}

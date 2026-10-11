export const subjectRequestByteLimit: number
export function discussionSubjectRequest(value: unknown): {
  model: string; store: false; stream: true; tools: never[]; instructions: string;
  input: { role: 'user'; content: string }[];
}
export function normalizeDiscussionSubject(value: unknown): string | undefined

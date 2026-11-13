// Secondary transcripts: the subagent files Claude Code writes beside a session transcript. The relay
// and the transcript watch share these limits and wire types.

/** The file name of a Claude Code subagent transcript. */
export const SECONDARY_NAME = /^agent-[A-Za-z0-9_-]{1,120}\.jsonl$/;
/** The most secondary transcripts one session lists, streams, and reads. */
export const MAX_SECONDARY_FILES = 64;
/** The most stream passes (one chunk or one end mark each) the secondaries of one relay run may spend together. */
export const MAX_SECONDARY_PASSES = 128;

/** `id` is the file's identity, `<device>:<inode>` in decimal. A new file under an old name has another id. */
export const SECONDARY_ID = /^[0-9]{1,20}:[0-9]{1,20}$/;

/** The secondary transcripts beside a primary, sent on the primary end mark. `total` counts every matching file. */
export interface SecondaryListing {
  files: { name: string; size: number; id: string }[];
  total: number;
}

/** A secondary transcript the worker wants, and the byte it has read up to. */
export interface SecondaryRequest {
  name: string;
  after: number;
}

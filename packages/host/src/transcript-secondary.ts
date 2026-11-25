export const SECONDARY_NAME = /^agent-[A-Za-z0-9_-]{1,120}\.jsonl$/;
export const MAX_SECONDARY_FILES = 64;
export const MAX_SECONDARY_PASSES = 128;

export const SECONDARY_ID = /^[0-9]{1,20}:[0-9]{1,20}$/;

export interface SecondaryListing {
  files: { name: string; size: number; id: string }[];
  total: number;
}

export interface SecondaryRequest {
  name: string;
  after: number;
}

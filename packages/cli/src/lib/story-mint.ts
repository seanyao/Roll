import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSpecMd, renderStoryPage, type StoryCardMeta } from "./story-page.js";

/** The one filesystem writer for a newly minted Story card. */
export function writeStoryCardFiles(cardDir: string, meta: StoryCardMeta): void {
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "spec.md"), renderSpecMd(meta), "utf8");
  writeFileSync(join(cardDir, "index.html"), renderStoryPage(meta), "utf8");
}

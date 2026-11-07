# Vietnamese caption editing

Captions are edited text, not a raw transcript. One caption per segment id goes
into `data/captions-vi.json` (`{ "g001": "…", "g002": "…" }`).
`build-timeline.py` chunks each one to ≤ 9 words and times the chunks against
the spoken words, so the editor never deals with timestamps.

This is cheapest-tier work: `cheapest · low`, in batches of ~150 segments. Each
batch writes its own `data/captions-vi.<batch>.json`, and the operator merges
them. Give every editor the same term list, so terms read the same across
batches.

## Brief

```text
Goal: edit Vietnamese captions for segments <first>..<last> of <project>.
Read: <skill>/references/captions-vi.md, the segments table for your range
  (python -X utf8 <skill>/scripts/tl.py <project> list, or the segments.py table), data/terms.json.
Owns: data/captions-vi.<batch>.json only.  Must not touch: everything else.
Done means: one entry per segment id in your range, valid JSON, UTF-8.
Return: the path, the entry count, and up to 5 terms you were unsure about.
```

## Criteria

1. **Meaning first.** Keep what the speaker meant, not every word they said.
   Drop fillers ("ờ", "à", "kiểu là", "thì là"), false starts and repeated
   words. Never add a claim the speaker did not make.
2. **Terms.** Keep product names, commands, code and English technical terms
   as written in `data/terms.json`: `Claude Code`, `subagent`, `token`,
   `commit`, `9:16`. Do not translate them and do not change their case. Write
   numbers as digits (`30%`, `3 bước`, `v3.34`).
3. **Proper nouns.** Use the spelling the speaker's own material uses, such as
   slides, the repo or the website. An unknown name keeps its transcript
   spelling and goes into the "unsure" list.
4. **Line breaks.** Write plain sentences without manual line breaks. Put
   commas and full stops where a viewer would pause, because the chunker splits
   there first. Keep each sentence under ~18 words, so no chunk is left with
   one orphan word.
5. **Register.** Spoken, direct, and in the speaker's own pronouns ("mình",
   "bạn"). No formal written phrasing.
6. **Full diacritics.** Every word has its tone marks. Fix the transcript's
   diacritic errors (`chu y` → `chú ý`).
7. **One caption per segment.** A segment the EDL dropped gets no caption.
   Every kept segment gets one, even a short one ("Đúng vậy.").

## Checks before returning

- The JSON parses, and every key is a segment id in the batch range.
- No caption is empty. None runs past ~40 words, which means the speech
  ran on, so tell the operator.
- The terms match `data/terms.json` exactly.

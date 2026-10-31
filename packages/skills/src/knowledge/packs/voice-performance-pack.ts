import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";

const VOICE_REFS = "kits/marketing/skills/ak-elevenlabs/references";

export const voicePerformancePack: KnowledgePack = {
  id: "voice-performance",
  version: "1.0.0",
  title: "Voice performance",
  summary:
    "Writing dialogue and voice-over for the ear, and directing its performance for TTS voices and actors.",
  purpose:
    "The writer is also the voice director; the voice (synthetic or human) is the performer. Write lines that are " +
    "speakable and unambiguous aloud, plan the emotional path before marking it, direct delivery with punctuation " +
    "and audio tags only where the voice provider supports them, and keep everything a listener should not hear " +
    "out of the spoken text.",
  sources: [
    agentkitSource(`${VOICE_REFS}/scriptwriting-and-performance-guide.md`, "EL-05"),
    agentkitSource(`${VOICE_REFS}/voice-design-prompting-guide.md`, "EL-05"),
  ],
  phases: ["script", "sound", "qa"],
  loadWhen: [
    "voice-over",
    "narration",
    "dialogue",
    "tts",
    "text to speech",
    "voice acting",
    "performance",
    "audio tags",
    "voice direction",
    "voice design",
  ],
  useCases: [
    "Turning a rough idea or ad copy into a performance-ready narration script with beats, pauses and emphasis.",
    "Enhancing an approved script's delivery without changing a single spoken word.",
    "Directing a multi-speaker scene: distinct voices, labelled turns, interruptions and overlaps.",
    "Writing a natural-language description to design or cast a voice that fits a character.",
    "Running the readability pass on a script before it is synthesised or recorded.",
  ],
  antiPatterns: [
    "Dense written prose sent to a voice: nested clauses, parentheses and footnote logic a listener cannot follow.",
    "Unexpanded numbers, dates, currencies, symbols, acronyms or links that are read ambiguously aloud.",
    "Visual references ('see below', tables, bullet fragments) left in a spoken script.",
    "A direction tag on every line, or a tag that contradicts what the line means.",
    "Visual stage directions (smiles, looks away, paces) inside the spoken text instead of the production notes.",
    "An unmotivated jump between emotional states, which sounds broken.",
    "Rewording, adding or dropping lines while 'enhancing' a script that was meant to keep its words.",
    "All characters in a dialogue drifting into one shared tone.",
    "Voice descriptions that are vague ('exotic', 'foreign', 'interesting'), contradictory, overlong, or that " +
      "imitate a specific real person.",
  ],
  sections: [
    {
      id: "script-modes",
      title: "Working modes",
      entries: [
        {
          id: "mode-script",
          title: "Write: idea or rough copy to performance script",
          text:
            "Resolve intent first: narration, commercial, story, comedy, character piece, explainer or dialogue, " +
            "plus language, length, audience, voice character and target voice. Then write for speech, plan the " +
            "beats, add only directions the voice supports, tune punctuation and line breaks for timing, and run " +
            "the readability pass. Produce audio only when it is wanted and the script passes.",
          tags: ["workflow"],
        },
        {
          id: "mode-enhance",
          title: "Enhance: keep the words, improve the delivery",
          text:
            "Every spoken word stays, in order and in meaning; never wrap original text in a tag. Add a direction " +
            "only where it changes that line's delivery and leave neutral lines bare. Punctuation, emphasis " +
            "capitals, ellipses and question or exclamation marks may change. Narrative stays narrative ('He " +
            "laughed' remains; a laugh direction may follow it). Self-check: strip all directions and compare with " +
            "the input; any word-level difference beyond punctuation or capitalisation is a defect.",
          tags: ["workflow"],
        },
        {
          id: "mode-dialogue",
          title: "Dialogue: direct several speakers",
          text:
            "Give each speaker a distinct voice and a short character note (age, energy, attitude, pace) in the " +
            "production notes. One labelled turn per line, with per-turn directions inside the turn; the label is " +
            "metadata, never spoken. Mark interruptions with a trailing dash on the cut line and a leading dash or " +
            "a 'jumping in' direction on the next; mark overlaps and hesitations explicitly. Keep the characters' " +
            "deliveries apart, and split long scenes to fit the provider's request size.",
          tags: ["workflow", "dialogue"],
        },
      ],
    },
    {
      id: "writing-for-the-ear",
      title: "Writing for the ear",
      entries: [
        {
          id: "ear-sentence-shape",
          title: "Sentence shape",
          text:
            "One idea per sentence; mostly short sentences, with an occasional longer one for rhythm. Use the " +
            "spoken phrasing and contractions natural to the language and register. Put the subject first; avoid " +
            "nested clauses and parentheses.",
        },
        {
          id: "ear-repeat-nouns",
          title: "Repeat nouns, not pronouns",
          text: "Listeners cannot re-read, so repeat the key noun where a pronoun could point at two things.",
        },
        {
          id: "ear-speakable-text",
          title: "Make everything speakable",
          text:
            "Spell out anything that reads ambiguously aloud: numbers, dates, currencies, units, abbreviations, " +
            "web addresses, symbols and acronyms (decide whether letters are spelled or read as a word). Remove " +
            "visual-only references such as tables, bullets or 'see below'.",
        },
        {
          id: "ear-absorb-pauses",
          title: "Pause where the listener needs it",
          text: "Place an intentional pause after a point the listener has to absorb before the next one arrives.",
        },
      ],
    },
    {
      id: "performance-beats",
      title: "Performance beats",
      entries: [
        {
          id: "beat-map",
          title: "Map the emotional path before marking it",
          text:
            "Answer six questions per script before adding any direction. Transitions must be motivated by the " +
            "text; a jump from sobbing to cheerful with no cause sounds broken.",
          fields: {
            openingState: "How does the speaker feel on the first word?",
            turns: "Where does the feeling change, and why?",
            emphasis: "Which one or two words per sentence carry the meaning?",
            pauses: "Where does the listener need a beat?",
            reactions: "Where would a real person laugh, sigh or breathe?",
            endingState: "How should the last line land?",
          },
        },
      ],
    },
    {
      id: "delivery-directions",
      title: "Directing delivery",
      entries: [
        {
          id: "audio-tags",
          title: "Audio tags where the voice provider supports them",
          text:
            "Inline directions are free natural-language descriptions of a sound, not a fixed list ('tired, barely " +
            "above a whisper'). Place one right before the words it colours; it holds until redirected. Aim for " +
            "about one per emotional change, not one per sentence. Prefer voice-quality wording ('low, gravelly " +
            "voice') over sound-effect wording when you mean delivery. Combine sparingly and audition the result; " +
            "flag experimental directions such as accents or singing as voice-dependent. On a voice without tag " +
            "support the tags may be read aloud or ignored, so direct it with wording and punctuation instead.",
          tags: ["tags"],
        },
        {
          id: "tags-are-auditory",
          title: "Directions must be audible",
          text:
            "Only directions a listener can hear go into the spoken text. Visual actions belong in the production " +
            "notes; never turn a visual action into a tag.",
          tags: ["tags"],
        },
        {
          id: "punctuation-control",
          title: "Punctuation as performance control",
          text:
            "Punctuation and line structure shape timing on every voice. Where a provider offers explicit break " +
            "markup instead of tags, use it sparingly.",
          fields: {
            ellipsis: "Hesitation, trailing off, weight before a reveal",
            dash: "Abrupt cut, interruption, self-correction",
            comma: "Short breath",
            lineBreak: "Larger pause or scene shift",
            capitals: "Emphasis on one word, never a whole sentence",
            questionExclamation: "Intonation lift or added energy",
          },
        },
        {
          id: "hesitation-breath",
          title: "Hesitation and breath",
          text:
            "Write hesitation as it is spoken: fillers, ellipses, a restart after a dash ('I was going to... no. " +
            "Never mind.'). Mark breath with an inhale or exhale direction, or a paragraph break before a heavy line.",
          tags: ["nonverbal"],
        },
        {
          id: "laughter-whisper-strain",
          title: "Laughter, whispering, crying",
          text:
            "Scale laughter (a chuckle, a laugh, a harder laugh) and place it where the joke lands, not before. Put " +
            "a whisper direction right before the secret and return with an explicit normal-voice direction or a " +
            "clear scene break. For crying or strain, keep the words intelligible.",
          tags: ["nonverbal"],
        },
        {
          id: "comedy-timing",
          title: "Comedy timing",
          text:
            "Plain setup, a beat, a short punchline: put a pause right before the punchline and any reaction after " +
            "it. Deadpan usually needs no direction; add one only if the voice drifts upbeat. Direct the delivery " +
            "('dry', 'mock-serious'), never the intent ('funny').",
          tags: ["comedy"],
        },
      ],
    },
    {
      id: "narration-and-language",
      title: "Narration, dialogue and language",
      entries: [
        {
          id: "narration-vs-dialogue",
          title: "Narration versus dialogue",
          text:
            "Narration: a steadier voice, fewer directions set at scene or paragraph level, pacing driven by " +
            "paragraph structure. Dialogue: per-turn directions, interruptions, distinct and livelier voices. Keep " +
            "narrator lines and character lines in separate turns.",
        },
        {
          id: "multilingual-scripts",
          title: "Scripts in other languages",
          text:
            "Write natively in the target language rather than translating; English direction words are fine, " +
            "literal translations of them are not. Follow that language's conventions for numbers, dates and " +
            "honorifics, confirm the chosen voice supports the language, and note pronunciation risks (names, " +
            "loanwords) with a phonetic spelling in the production notes.",
        },
      ],
    },
    {
      id: "voice-design",
      title: "Describing a voice",
      entries: [
        {
          id: "voice-attributes",
          title: "Five attributes of a voice description",
          text:
            "Describe a voice to design or cast by five attributes; a detailed description lands closer than a " +
            "short one, while a short one suits a neutral narrator.",
          fields: {
            age: "Adolescent, young adult, middle-aged, elderly",
            gender: "Male, female, neutral, or pitch descriptors",
            timbre: "Deep, smooth, gravelly, warm, breathy, tinny",
            accent: "A specific accent with a strength ('slight' or 'thick')",
            pacing: "Fast, slow, deliberate, conversational, rhythmic",
          },
        },
        {
          id: "voice-description-craft",
          title: "Writing the description",
          text:
            "Be specific (a named accent beats 'foreign'), layer compatible descriptors, add the use and the " +
            "situation (a narrator for long-form, a commentator mid-match), and state the recording quality: " +
            "studio-clean, or deliberately lo-fi such as a phone line or a muffled, distant room. Preview with text " +
            "that suits the voice; longer previews give a steadier read. Generate several candidates and pick one.",
        },
      ],
    },
    {
      id: "delivery-contract",
      title: "Readability pass and hand-off",
      entries: [
        {
          id: "readability-pass",
          title: "Voice-readability pass",
          text:
            "Before synthesis or recording: the script reads naturally aloud at the intended pace; numbers and " +
            "symbols are speakable; directions are audible, motivated and not on every line; emotional transitions " +
            "are plausible; pauses use markup the voice supports; no visual stage directions are in the spoken " +
            "text; each chunk fits the provider's request size and long-form text splits at natural boundaries; " +
            "an enhanced script still matches its input wording.",
          tags: ["checklist"],
        },
        {
          id: "two-layer-output",
          title: "Performance script plus production notes",
          text:
            "Deliver two layers. The performance script is exactly the text to voice, with directions and " +
            "performance punctuation and nothing else. The production notes are never spoken: voice " +
            "characteristics, risky or experimental directions, pronunciation notes, the chunking plan and lines " +
            "likely to need another take. An enhance job returns only the enhanced script unless analysis is asked for.",
        },
      ],
    },
  ],
  checks: [
    {
      id: "voice-performance.enhance-wording-preserved",
      kind: "evidence",
      level: "asset",
      measure:
        "The enhanced script with every direction stripped, compared word by word with the input script.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "No word is added, removed, reordered or reworded; only punctuation and capitalisation differ.",
    },
    {
      id: "voice-performance.spoken-text-clean",
      kind: "evidence",
      level: "asset",
      measure:
        "The performance script, checked for visual stage directions, speaker labels read as text, visual-only " +
        "references and unexpanded numbers, symbols or acronyms.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "Everything in the performance script is meant to be heard and is unambiguous when read aloud.",
    },
    {
      id: "voice-performance.direction-density",
      kind: "evidence",
      level: "asset",
      measure: "Direction tags against the beat map: where each sits and what change it marks.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass:
        "Tags mark emotional changes rather than every line, none contradicts its line, and every transition is " +
        "motivated by the text.",
    },
    {
      id: "voice-performance.distinct-voices",
      kind: "evidence",
      level: "scene",
      measure: "The reviewer listens to a multi-speaker scene.",
      judges: ["ai", "human"],
      evidence: ["audio"],
      pass: "Each speaker is identifiable by voice and delivery alone, and the characters do not converge on one tone.",
    },
    {
      id: "voice-performance.performance-reads",
      kind: "evidence",
      level: "asset",
      measure: "The user listens to the voiced take.",
      judges: ["human"],
      evidence: ["audio"],
      pass: "The user confirms the delivery follows the intended emotional path and lands the ending as planned.",
    },
  ],
};

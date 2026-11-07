# Video Production Workflow

AI-powered workflow with quality review gates at every stage.

## Phase 1: Pre-Production

### Planning
- [ ] Define video goal and KPI
- [ ] Identify target audience
- [ ] Choose platform and format
- [ ] Research competitors/trends
- [ ] Create content brief

### Scripting
- [ ] Write script using template (with start/end frame descriptions)
- [ ] Time each section (max 8s per scene)
- [ ] Include Imagen prompts for each scene
- [ ] **[REVIEW 1]** AI script review (grammar, timing, hooks)
- [ ] Apply any explicit stakeholder gate; otherwise continue within the accepted brief.

### Storyboarding
- [ ] Generate frame prompts from script
- [ ] Ensure visual continuity (end frame N = start frame N+1)
- [ ] Apply consistent style tags
- [ ] **[REVIEW 2]** AI storyboard review (clarity, feasibility)

## Phase 2: AI Production

### Audio Generation
- [ ] Generate voiceover (Gemini TTS)
- [ ] Generate background music (Lyria)
- [ ] **[REVIEW 3]** AI audio review (clarity, pronunciation, mood)

### Frame Generation (Imagen 4)
- [ ] Generate start frames for each scene
- [ ] Generate end frames for each scene
- [ ] **[REVIEW 4]** AI frame review per scene:
  - Quality score ≥ 8
  - No abnormalities (extra limbs, distorted faces)
  - Text accuracy if present
  - Prompt adherence
- [ ] Regenerate failed frames

### Video Generation (Veo 3.1)
- [ ] Generate video clip per scene (start → end frame)
- [ ] **[REVIEW 5]** AI video review per clip:
  - Motion quality ≥ 8
  - No artifacts or morphing
  - Temporal consistency
  - Action accuracy
- [ ] Regenerate failed clips

## Phase 3: Post-Production

### Assembly (FFmpeg)
- [ ] Concatenate video clips
- [ ] Mix voiceover (-12dB)
- [ ] Mix background music (-18dB)
- [ ] Apply ducking (sidechain compress)
- [ ] Add SFX at timestamps

### Quality Review
- [ ] **[REVIEW 6]** AI final review:
  - A/V synchronization
  - Transition smoothness
  - Narrative flow
  - Caption accuracy
  - Hook effectiveness (first 3s)
  - CTA clarity (last 3s)
  - Overall polish score ≥ 8
- [ ] Apply fixes if needed
- [ ] Re-review until passed

### Export
- [ ] Export master (highest quality)
- [ ] Optimize for target platform(s)
- [ ] Create thumbnail only when requested
- [ ] Generate captions/subtitles

## Phase 4: Publishing (When Authorized)

### Upload
- [ ] Schedule optimal time
- [ ] Add metadata (title, desc, tags)
- [ ] Set thumbnail
- [ ] Add end screens/cards

### Promote
- [ ] Share to social channels
- [ ] Email list announcement
- [ ] Engage early comments
- [ ] Cross-promote clips

## Review Gate Summary

| Gate | Stage | Tool | Checks |
|------|-------|------|--------|
| R1 | Script | Gemini text | Grammar, timing, hooks |
| R2 | Storyboard | Gemini text | Clarity, continuity, feasibility |
| R3 | Audio | Gemini audio | Clarity, pronunciation, mood |
| R4 | Frames | Gemini vision | Quality, abnormalities, accuracy |
| R5 | Video clips | Gemini video | Motion, artifacts, consistency |
| R6 | Final | Gemini video | A/V sync, polish, publish-ready |

**Pass criteria**: All gates must pass before proceeding.
**Retry limit**: 2 regeneration attempts per asset.
Review cost depends on the selected provider and actual usage; do not assert a fixed total.

## Perform the Applicable Review

Use available native inspection or a discovered media-analysis capability to check the stage's actual artifact. Review script text and timing, storyboard continuity, frame fidelity, clip motion, audio clarity, and final synchronization only for stages included in the request. Do not invoke a nonexistent review script or treat a self-reported score as render proof.

## Resources

- Quality Review Details: `./quality-review-workflow.md`
- Script Templates: `./script-templates.md`
- Storyboard Format: `./storyboard-format.md`

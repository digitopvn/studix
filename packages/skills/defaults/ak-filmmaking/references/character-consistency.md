# Character consistency

Character identity is the highest-priority visual requirement, and it comes from
assets, not adjectives. Work image-first, video-second.

## Reference pack

For each recurring character build, review and approve before any video:

- front, three-quarter left, three-quarter right, profile, full body;
- neutral plus the key expressions the script needs;
- canonical hairstyle and accessories (recorded as text in the bible too);
- each wardrobe state as its own `bibles/wardrobe/<id>.json` with images.

Generate the pack with the installed image-generation skill, from one approved
front image outward so every view derives from the same identity. Use a neutral
background and even light; style the film later, not the reference.

`validate` requires a canonical `front` for the current `identity_version` and
for every version a scene pins, and warns when the other core views are missing.

## Canonical, candidate, retired

| Status | Meaning |
|---|---|
| `canonical` | Approved identity; may condition shots |
| `candidate` | Generated or proposed; never conditions a shot |
| `retired` | Superseded; kept for history |

Promotion is an explicit step: the user approves a candidate, its status becomes
`canonical`, and `promoted_from` records the source generation. A frame from a
good generation is still a candidate until promoted; `validate` rejects shots
that reference one.

## Identity versions

An intentional identity change (haircut after a time jump, aging, injury that
persists) bumps the character's `identity_version` and adds canonical images at
the new version. Scenes before the change (or a flashback) pin the older look
in `scene.json`:

```json
"identity_versions": {"MAI_01": 1}
```

A scene without an entry uses the bible's latest version. `validate` rejects a
shot whose identity references depict a different version than its scene uses,
and a pinned version above the bible's, so a change cannot leak backwards or
forwards unnoticed.
Temporary states (wet hair, dirt, a wound) belong in shot `conditions`, not in
a new identity version.

## Carrying identity into shots

Every non-PREVIS shot lists canonical references for each visible character,
plus wardrobe and location references when they exist; `film.py prompt` orders
them identity -> wardrobe -> location -> props and names each image slot in the
prompt text. Approve a still keyframe built from those references before
animating any STANDARD, CHARACTER_CRITICAL or HERO shot.

## Drift

Treat identity drift as a QC failure (`identity`, `hair`, `accessories`,
`wardrobe`) that returns the shot to STORYBOARDED: fix the keyframe from the
canonical pack and re-approve it. Do not chase drift with prompt adjectives on
the video pass, and never repair drift by promoting the drifted frame.

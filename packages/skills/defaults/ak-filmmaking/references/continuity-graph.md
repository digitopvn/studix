# Continuity graph

Each shot reads the state it inherits and writes the state the next shot
inherits. A shot cannot silently mutate continuity.

## Where each kind of state lives

| State | Owner |
|---|---|
| Identity version, canonical hair, accessories | Character bible |
| Location, time of day, weather, lighting | Scene |
| Wardrobe per character | Scene (shot copies it; a change must be declared) |
| Prop holder/position (`MAI_01:right_hand`, `table:left`) | Shot `continuity.prop_states` |
| Left/right screen side | Shot `continuity.screen_positions` |
| Physical conditions (wet, dirt, wound, makeup smear) | Shot `continuity.conditions` |
| Movement direction | Shot `continuity.screen_direction` |
| Emotional state | Shot `emotion` |

## Links

`continuity_from` and `continuity_to` form a chain along the cut and must link
back to each other. Link across scene boundaries when state carries (rain-damp
hair walking into the cafe). Leave `continuity_from` null only at a true reset;
`validate` warns about any other shot without one.

## Carried state

For every character and prop in a shot, the continuity check compares against
the nearest earlier shot in the chain where that character or prop was on
screen, so state survives reaction shots and cutaways. It reports an error at
the cut's timecode when, without a declaration:

- wardrobe changes;
- a character flips between screen-left and screen-right (center and offscreen
  are neutral for the 180-degree rule);
- conditions change (gaining or losing `wet`, `damp_hair`, a wound);
- a prop's holder or position changes;
- movement reverses between `left_to_right` and `right_to_left` across a cut.

## Declaring intended change

```json
"continuity_changes": [
  {"field": "prop_states.UMBRELLA_01", "reason": "Mai hangs the umbrella on her chair as she sits."}
]
```

Field paths are `wardrobe.<CHAR>`, `screen_positions.<CHAR>`,
`conditions.<CHAR>`, `prop_states.<PROP>` or `screen_direction`. The action that
causes the change should be visible in this shot or clearly implied by the cut.
A declaration that does not match a real change is reported as a warning so
stale reasons do not accumulate.

## Run it

```bash
python3 scripts/film.py continuity films/<slug>
```

Fix continuity in the graph first, then in the storyboard; never accept a
rendered shot that contradicts the graph and "fix the graph to match".

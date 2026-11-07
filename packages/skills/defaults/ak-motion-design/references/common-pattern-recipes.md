# Common Patterns

## Button Press (Playful)
1. **Anticipation**: Scale to 0.97 (50ms, ease-out)
2. **Squash**: Scale to [1.04, 0.96] (100ms, ease-in)
3. **Follow through**: Overshoots to 1.02, settles to 1.0 (spring, 200ms)
4. **Secondary**: Shadow shrinks during press, icon shifts down 2px
5. **Total**: ~150ms press + 200ms settle

## Card Entrance (Premium)
1. **Start**: 20px below target, opacity 0
2. **Path**: Slight curve (10px X offset at midpoint)
3. **Easing**: ease-out-cubic deceleration
4. **Follow through**: Shadow arrives 50ms after card
5. **Secondary**: Content fades in 100ms after card lands
6. **Staging**: Other cards dim to 80%

## Success State (Playful)
1. **Primary**: Scale pop with ease-out-back
2. **Secondary**: Checkmark draws in
3. **Ambient**: Subtle particle burst
4. **Color**: Green fill
5. **Total**: 300-400ms

## Error Shake (Corporate)
1. **Primary**: Position oscillates 2-3 times, ±10-15px horizontal
2. **Easing**: ease-in-out for sharp stops
3. **Color**: Red tint
4. **Total**: 300-400ms
5. **No overshoot**: Errors feel firm

> More patterns: [patterns/entrance-exit.md](../patterns/entrance-exit.md) | [patterns/state-feedback.md](../patterns/state-feedback.md)

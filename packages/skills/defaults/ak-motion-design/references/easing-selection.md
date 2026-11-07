# Easing Selection

**Directional rules**:
- **Entrance** → decelerate (fast start, gentle landing): ease-out family
- **Exit** → accelerate (gentle start, fast departure): ease-in family
- **On-screen** → smooth both ends: ease-in-out family
- **Looping ambient** → seamless: sine-based ease-in-out

**Industry standards**:

| Standard | Cubic Bezier | Use For |
|----------|-------------|---------|
| Material Design 3 | (0.2, 0, 0, 1) | Default on-screen |
| MD3 Emphasized | (0.05, 0.7, 0.1, 1) | Entrances, attention |
| MD3 Accelerate | (0.3, 0, 1, 1) | Exits, dismissals |
| Apple HIG | (0.25, 0.1, 0.25, 1) | Standard iOS |
| Snappy UI | (0.2, 0, 0, 1) | Fast, decisive |
| Gentle float | (0.4, 0, 0.2, 1) | Ambient, background |
| Bounce settle | (0.175, 0.885, 0.32, 1.275) | Overshoot, playful |

**Material-based easing**:

| Material | Duration Scale | Overshoot |
|----------|---------------|-----------|
| Rigid (metal, stone) | 1.2x | 0% |
| Elastic (rubber, gel) | 0.8x | 15-25% |
| Fluid (water, paint) | 1.5x | 5% |
| Paper (cards, sheets) | 1.0x | 3-5% |
| Gas (smoke, fog) | 2.0x | 0% |
| Glass (brittle) | 0.9x | 0% |

> Deep dive: [reference/timing-easing-tables.md](../reference/timing-easing-tables.md)

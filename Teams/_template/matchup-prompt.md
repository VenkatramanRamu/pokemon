# Post-match analysis — copy/paste prompt

Copy the block below into a fresh Claude conversation and fill in the fields. Delete any optional lines you don't have data for.

---

```
Post-match analysis request.

Team I used:        <e.g. Mega Greninja>
Opponent's 6:       <species 1, species 2, species 3, species 4, species 5, species 6>
Their bring (4):    <species, species, species, species>
Their lead (2):     <species + species>
Their remaining 2:  <species, species>      (skip if you didn't make it that far)

My bring (4):       <species, species, species, species>
My lead (2):        <species + species>

Result:             <won / lost / drew>
What happened:      <optional — turn-by-turn notes, what died first, anything you noticed about their abilities/items>

Please produce a matchup file under Teams/<my team>/matchups/.
```

---

## Notes when filling this out

- **Species names:** full names are best. Shorthand (Inc / Garch / Vanil / Geng / Whim / Sin / Floe / Sneas) is okay if you're in a hurry.
- **Items / abilities you saw:** include them inline next to the species (e.g. `Ceruledge (Flash Fire?)`, `Pelipper (Damp Rock)`). These are the highest-value details for sharpening the analysis.
- **What happened:** even one line helps. "Lost both leads T1" or "Their Ceruledge ate my Heat Wave for 0 damage" or "Sucker Punch broke Meowstic's Sash" is enough to tell Claude *why* the plan failed.
- **If you didn't make it past the leads:** leave "remaining 2" blank — Claude can still produce a matchup file based on what you saw.

## Filename Claude will use

`Teams/<my team>/matchups/<archetype>.md` — e.g. `rain-ghost-froslass-ceruledge.md`. Archetype + key threats, not opponent username (same archetype recurs).

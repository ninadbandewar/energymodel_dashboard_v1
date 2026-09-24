# Energy Model Dashboard V1

## Structure
- `parser/parse_results.py` — select `Final Simulation Reports`; writes private `data/` and public `docs/data/`.
- `parser/build_reference.py` — select `Final Simulation Reports`; writes `docs/data/reference_metrics.json`.
- `docs/` — public GitHub Pages site.

## Parser output
The parser's public output is now under `docs/data/`. Run the parser again for a clean rebuild after this folder change.

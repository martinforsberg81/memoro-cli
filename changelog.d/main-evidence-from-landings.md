section: Fixed

- **Measured landings keep main evidence current.** Identical squash landings,
  including batches and documents-only rounds, write per-commit test coverage
  and inherit unchanged reach from their base. PR rounds distinguish covered
  green, covered red and unknown without replaying main; the existing
  untouched-file, name-and-diagnostic exemption is unchanged. Full runs still
  write independent whole-suite evidence; admin landings leave a gap.

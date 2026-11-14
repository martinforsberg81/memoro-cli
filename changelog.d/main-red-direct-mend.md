section: Changed

- **Main's red queues a goal-less mend session directly**, at merge-recovery
  priority. Per-file requests deduplicate active repairs, keep one branch through
  retry, track publication and landing, and show exhausted recovery on Martin's
  queue without creating main-health goals. Existing repair goals finish normally.

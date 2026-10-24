section: Changed

- **`mc project criterion add` and `edit` refuse a check that gives `node --test` a directory.** Node 24 tries to load a directory as a module and fails with `MODULE_NOT_FOUND`, so such a check never passes whatever the code does; the refusal names the directory and a quoted glob to write instead. A sent plan that already holds one stays valid: `validatePlan` and `send` do not refuse it.

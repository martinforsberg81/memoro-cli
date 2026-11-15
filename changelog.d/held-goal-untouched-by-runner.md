section: Fixed

- **The runner writes nothing on a goal that is held when its session ends, and a draft made outside a headless session is held from creation.** Before, a hold only stopped session starts, so a plan session that ended on a held draft set it `Martin`, and next-draft planning took a draft its author was still writing.

Programme records now have draft/open/done/dropped states and nullable signature
and cut keys. Existing version 1 records read as legacy without disk changes;
actual writes upgrade them. Phase, archive-state and sign/return/drop record
writers retain concurrent fields under the runner's strict lock. Signing captures
the working page and nested design hashes in a separate signed copy.

New programme pages use the complete document template and structural checks;
area repairs retain their short page. Horizon show names the desk-authored basis.

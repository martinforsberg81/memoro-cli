Programme record phase and archive-state updates now retain concurrent fields
under the runner's strict lock, refusing a write when the lock cannot be taken.

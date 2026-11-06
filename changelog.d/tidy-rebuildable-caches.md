section: Added

- **Automatic cleanup of exact rebuildable caches.** Tidy now handles ended
  native-phone probe outputs, idle registered worker bundles and named SwiftPM,
  iOS derived-data, device-installation and compiled media-analysis caches.
  Shared caches retain 72 hours; every deletion rechecks activity, ownership
  and complete tree identity. Screenshot checks use exact-file batches so
  unrelated browser-profile inventory failures do not block old closed images.

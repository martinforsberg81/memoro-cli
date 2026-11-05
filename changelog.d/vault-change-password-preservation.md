section: Fixed

- **Vault password changes refuse unsafe prerequisites before rotation.** Run
  `mc vault migrate` separately while the old password works; complete custody
  envelopes keep their ciphertext and the same root is rewrapped. Password
  rotation is never retried automatically after transport loss. Unreadable
  confirmation reports an unknown outcome and clears this device's cached key;
  check by unlocking. The CLI check is not a concurrent-writer barrier: that
  requires the companion server envelope boundary, not deployed by this change.

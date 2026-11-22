section: Fixed

- **`mc deploy` reads a live commit verified as `<sha>-dirty` as `<sha>`.** A
  deploy whose tree carried stamped container pins was verified live as
  `a5d5bd8-dirty`; every later `mc deploy` looked that string up as a commit,
  found none and refused with "the live commit … is not a commit this checkout
  has", so nothing could ship.

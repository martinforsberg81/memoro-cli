section: Changed

- **A merge round starts Docker before a command gate that needs it.** A selector entry with `needs: ["docker"]` gets the runtime started, a lease for the round and the label variables; a runtime that will not start is said by name. Inert until memoro's selector sends `needs`.
